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
  EMPTY,
  Observable,
  of as observableOf,
} from "rxjs";
import {
  concatMap,
  finalize,
  map,
  mergeMap,
} from "rxjs/operators";
import config from "../../config";
import castToObservable from "../cast_to_observable";
import {
  IRequestOptions,
  IRequestProgress,
  IRequestResponse
} from "./types";
// import { RequestError, RequestErrorTypes } from "../../errors";

const { DEFAULT_REQUEST_TIMEOUT } = config;

// const DEFAULT_RESPONSE_TYPE : XMLHttpRequestResponseType = "json";

// /**
//  * @param {string} data
//  * @returns {Object|null}
//  */
// function toJSONForIE(data : string) : unknown|null {
//   try {
//     return JSON.parse(data);
//   } catch (e) {
//     return null;
//   }
// }

//
// overloading to the max
function request(options :
  IRequestOptions<undefined|null|""|"text", false|undefined>
) : Observable<IRequestResponse<string, "text">|IRequestProgress>;
function request(options : IRequestOptions<undefined|null|""|"text", true>) :
  Observable<IRequestResponse<string, "text">>;
function request(options : IRequestOptions<"arraybuffer", false|undefined>) :
  Observable<IRequestResponse<ArrayBuffer, "arraybuffer">|IRequestProgress>;
function request(options : IRequestOptions<"arraybuffer", true>) :
  Observable<IRequestResponse<ArrayBuffer, "arraybuffer">>;
function request(options : IRequestOptions<"document", false|undefined>) :
  Observable<IRequestResponse<Document, "document">|IRequestProgress>;
function request(options : IRequestOptions<"document", true>) :
  Observable<IRequestResponse<Document, "document">>;
function request(options : IRequestOptions<"json", false|undefined>) :
  Observable<IRequestResponse<object, "json">|IRequestProgress>;
function request(options : IRequestOptions<"json", true>) :
  Observable<IRequestResponse<object, "json">>;
function request(options : IRequestOptions<"blob", false|undefined>) :
  Observable<IRequestResponse<Blob, "blob">|IRequestProgress>;
function request(options : IRequestOptions<"blob", true>) :
  Observable<IRequestResponse<Blob, "blob">>;
function request<T>(
  options : IRequestOptions<
    XMLHttpRequestResponseType|null|undefined, false|undefined
  >
) : Observable<
  IRequestResponse<T, XMLHttpRequestResponseType>|IRequestProgress
>;
function request<T>(
  options : IRequestOptions<XMLHttpRequestResponseType|null|undefined, true>
) : Observable<IRequestResponse<T, XMLHttpRequestResponseType>>;

function request<T>(
  options : IRequestOptions<
    XMLHttpRequestResponseType|null|undefined, boolean|undefined
  >
) : Observable<
  IRequestResponse<T, XMLHttpRequestResponseType>|IRequestProgress
> {
  const headers : Headers =
    typeof (window as any).Headers === "function" ?
      new (window as any).Headers() : null;
  const abortController : AbortController =
    typeof (window as any).AbortController === "function" ?
      new (window as any).AbortController() : null;

    if (options.headers != null) {
      const headerNames = Object.keys(options.headers);
      for (let i = 0; i < headerNames.length; i++) {
        const headerName = headerNames[i];
        headers.append(headerName, options.headers[headerName]);
      }
    }

    // let timeouted = false;
    const timeout = window.setTimeout(() => {
      // timeouted = true;
      abortController.abort();
    }, options.timeout == null ? DEFAULT_REQUEST_TIMEOUT : options.timeout);

    const sendingTime = performance.now();
    let lastSentTime = sendingTime;
    return castToObservable(
      fetch(
        options.url, {
          headers,
          method: "GET",
          signal: abortController.signal,
        }
      )
    ).pipe(
      concatMap((response) => {
        if (timeout != null) {
          clearTimeout(timeout);
        }

        const responseType =
          !options.responseType || options.responseType === "document" ?
            "text" : options.responseType;

        if (
          responseType === "arraybuffer" &&
          response.body
        ) {
          const reader = response.body.getReader();

          /**
           * Read last bytes from readable bytstream.
           * @return {Observable}
           */
          function readBuffer(): Observable<
            IRequestResponse<ArrayBuffer, "arraybuffer">
          > {
            return castToObservable(reader.read()).pipe(mergeMap(handleFetchedBytes));
          }

          /**
           * Handle fetched bytes from response's reader
           * @param {Object} chunk
           * @return {Observable}
           */
          function handleFetchedBytes(
            chunk: { done: boolean; value: Uint8Array }
          ): Observable<IRequestResponse<ArrayBuffer, "arraybuffer">> {
            const receivedTime = performance.now();
            const duration = receivedTime - lastSentTime;
            lastSentTime = receivedTime;
            const { value, done } = chunk;
            return done ? EMPTY :
              observableConcat(
                value != null && responseType === "arraybuffer" ? observableOf({
                  type: "response" as "response",
                  value: {
                    responseType,
                    status: response.status,
                    url: response.url,
                    sendingTime,
                    receivedTime,
                    duration,
                    size: value.length,
                    responseData: value.buffer,
                  },
                }) : EMPTY,
                readBuffer()
              );
          }

          return readBuffer();
        } else {
          return castToObservable((() => {
            switch (responseType) {
              case "arraybuffer":
                return response.arrayBuffer();
              case "json":
                return response.json();
              case "blob":
                return response.blob();
              case "text":
                return response.text();
            }
          })()).pipe(
            map((responseData) => {
              const receivedTime = performance.now();
              return {
                type: "response" as "response",
                value: {
                  responseType,
                  status: response.status,
                  url: response.url,
                  sendingTime,
                  receivedTime,
                  duration: receivedTime - sendingTime,
                  size: responseData instanceof ArrayBuffer ?
                  responseData.byteLength : 0,
                  responseData,
                },
              };
            })
          );
        }
      // }).catch((e) => {
      //   if (timeouted) {
      //     const errorCode = RequestErrorTypes.TIMEOUT;
      //     obs.error(new RequestError(xhr /* TODO */, url, errorCode));
      //     return;
      //   }
      // });
      }),
      finalize(() => {
        abortController.abort();
      })
  );
}

/**
 * Returns true if fetch should be supported in the current browser.
 * @return {boolean}
 */
export function fetchIsSupported() {
  return !!(
    window.fetch &&
    (window as any).AbortController &&
    (window as any).Headers
  );
}

export default request;
