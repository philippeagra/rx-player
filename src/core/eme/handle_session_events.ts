/**
 * Copyright 2015 CANAL+ Group
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  concat as observableConcat,
  defer as observableDefer,
  EMPTY,
  merge as observableMerge,
  Observable,
  of as observableOf,
  Subject,
  TimeoutError,
} from "rxjs";
import {
  catchError,
  concatMap,
  map,
  mapTo,
  mergeMap,
  takeUntil,
  timeout,
} from "rxjs/operators";
import {
  events,
  ICustomMediaKeySession,
} from "../../compat";
import {
  EncryptedMediaError,
  ErrorTypes,
  ICustomError,
  isKnownError,
} from "../../errors";
import log from "../../log";
import castToObservable from "../../utils/cast_to_observable";
import retryObsWithBackoff from "../../utils/rx-retry_with_backoff";
import tryCatch from "../../utils/rx-try_catch";
import {
  IEMEWarningEvent,
  IKeyStatusChangeEvent,
  IKeySystemOption,
} from "./types";

const {
  onKeyError$,
  onKeyMessage$,
  onKeyStatusesChange$,
} = events;

type TypedArray =
  Int8Array |
  Int16Array |
  Int32Array |
  Uint8Array |
  Uint16Array |
  Uint32Array |
  Uint8ClampedArray |
  Float32Array |
  Float64Array;

export type ILicense =
  TypedArray |
  ArrayBuffer;

interface ILicenseUpdateEvent {
  type: "license-update";
  value: {
    source: MediaKeyMessageType | "key-status-change";
    license: ILicense|null;
  };
}

export interface ILicenseUpdatedEvent {
  type: "license-updated";
  value : {
    source : MediaKeyMessageType|"key-status-change";
    session : MediaKeySession|ICustomMediaKeySession;
    license: ILicense;
  };
}

const KEY_STATUSES = {
  EXPIRED: "expired",
  INTERNAL_ERROR: "internal-error",
  OUTPUT_RESTRICTED: "output-restricted",
};

/**
 * @param {Error|Object} error
 * @param {Boolean} fatal
 * @returns {Error|Object}
 */
function licenseErrorSelector(
  error: ICustomError|Error,
  fatal: boolean
) : ICustomError|Error {
  if (isKnownError(error)) {
    if (error.type === ErrorTypes.ENCRYPTED_MEDIA_ERROR) {
      error.fatal = fatal;
      return error;
    }
  }
  return new EncryptedMediaError("KEY_LOAD_ERROR", error.toString(), fatal);
}

/**
 * listen to "message" events from session containing a challenge
 * blob and map them to licenses using the getLicense method from
 * selected keySystem.
 * @param {MediaKeySession} session
 * @param {Object} keySystem
 * @returns {Observable}
 */
export default function handleSessionEvents(
  session: MediaKeySession|ICustomMediaKeySession,
  keySystem: IKeySystemOption
) : Observable<ILicenseUpdatedEvent|IEMEWarningEvent|IKeyStatusChangeEvent> {
  log.debug("EME: Handle message events", session);

  const sessionWarningSubject$ = new Subject<IEMEWarningEvent>();
  const getLicenseRetryOptions = {
    totalRetry: 2,
    retryDelay: 200,
    errorSelector: (error: ICustomError|Error) => licenseErrorSelector(error, true),
    onRetry: (error: ICustomError|Error) =>
      sessionWarningSubject$.next({
      type: "warning",
      value: licenseErrorSelector(error, false),
    }),
  };

  const keyErrors: Observable<never> = onKeyError$(session)
    .pipe(map((error) => {
      throw new EncryptedMediaError("KEY_ERROR", error.type, true);
    }));

  const keyStatusesChanges : Observable<
    ILicenseUpdateEvent |
    IEMEWarningEvent |
    IKeyStatusChangeEvent
  > = onKeyStatusesChange$(session)
    .pipe(mergeMap((keyStatusesEvent: Event) => {
      log.debug("EME: keystatuseschange event", session, keyStatusesEvent);

      const warnings : Array<IEMEWarningEvent|IKeyStatusChangeEvent> = [];
      (session.keyStatuses as any).forEach((_arg1 : unknown, _arg2 : unknown) => {
        const [keyStatus, keyId] = (() => {
          return (typeof _arg1  === "string" ?
            [_arg1, _arg2] : [_arg2, _arg1]) as [MediaKeyStatus, ArrayBuffer];
        })();

        switch (keyStatus) {
          case KEY_STATUSES.EXPIRED: {
            const error = new EncryptedMediaError("KEY_STATUS_CHANGE_ERROR",
              "A decryption key expired", false);

            if (keySystem.throwOnLicenseExpiration !== false) {
              error.fatal = true;
              throw error;
            }
            warnings.push({ type: "warning", value: error });
            break;
          }

          case KEY_STATUSES.INTERNAL_ERROR: {
            const error = new EncryptedMediaError("KEY_STATUS_CHANGE_ERROR",
              "An invalid key status has been encountered: " + keyStatus, false);

            if (keySystem.throwOnInternalError !== false) {
              error.fatal = true;
              throw error;
            }
            warnings.push({ type: "warning", value: error });
          } // /!\ Do not break here
          case KEY_STATUSES.OUTPUT_RESTRICTED:
            warnings.push({
              type: "key-status-change" as "key-status-change",
              value: { keyId, keyStatus },
            });
        }
      });

      const warnings$ = warnings.length ? observableOf(...warnings) : EMPTY;
      const handledKeyStatusesChange$ = tryCatch(() => {
        return keySystem && keySystem.onKeyStatusesChange ?
          castToObservable(
            keySystem.onKeyStatusesChange(keyStatusesEvent, session)
          ) as Observable<TypedArray|ArrayBuffer|null> : EMPTY;
      }, undefined).pipe() // TS or RxJS Bug?
        .pipe(
          catchError((error: Error) => {
            throw new EncryptedMediaError("KEY_STATUS_CHANGE_ERROR",
              error.toString(), true);
          }),
          map((licenseObject) => ({
            type: "license-update" as "license-update",
            value : {
              source: "key-status-change" as "key-status-change",
              license: licenseObject,
            },
          }))
        );
      return observableConcat(warnings$, handledKeyStatusesChange$);
    }));

  const keyMessages$ : Observable<ILicenseUpdateEvent> =
    onKeyMessage$(session).pipe(mergeMap((messageEvent: MediaKeyMessageEvent) => {
      const message = new Uint8Array(messageEvent.message);
      const messageType = messageEvent.messageType || "license-request";

      log.debug(`EME: Event message type ${messageType}`, session, messageEvent);

      const getLicense$ = observableDefer(() => {
        const getLicense = keySystem.getLicense(message, messageType);
        return (castToObservable(getLicense) as Observable<TypedArray|ArrayBuffer|null>)
          .pipe(
            timeout(10 * 1000),
            catchError((error : Error) : never => {
              throw error instanceof TimeoutError ?
                new EncryptedMediaError("KEY_LOAD_TIMEOUT",
                  "The license server took more than 10 seconds to respond.", false) :
                error;
            })
        );
      });

      return retryObsWithBackoff(getLicense$, getLicenseRetryOptions)
        .pipe(map((license) => {
          return {
            type: "license-update" as "license-update",
            value: { source: messageType, license },
          };
        }));
    }));

  const sessionUpdates = observableMerge(keyMessages$, keyStatusesChanges)
    .pipe(
      concatMap((evt : ILicenseUpdateEvent|IEMEWarningEvent|IKeyStatusChangeEvent) :
        Observable<ILicenseUpdatedEvent|IEMEWarningEvent|IKeyStatusChangeEvent> => {
          if (evt.type !== "license-update") {
            return observableOf(evt);
          }

          const license = evt.value.license;

          if (license == null) {
            log.info("EME: No license given, skipping session.update");
            return EMPTY;
          }

          log.debug("EME: Update session", evt);
          return castToObservable((session as any).update(license)).pipe(
            catchError((error: Error) => {
              throw new EncryptedMediaError("KEY_UPDATE_ERROR", error.toString(), true);
            }),
            mapTo({
              type: "license-updated" as "license-updated",
              value: { source: evt.value.source, session, license },
            }));
        }));

  const sessionEvents =
    observableMerge(sessionUpdates, keyErrors, sessionWarningSubject$);

  return session.closed ?
    sessionEvents.pipe(takeUntil(castToObservable(session.closed))) :
    sessionEvents;
}
