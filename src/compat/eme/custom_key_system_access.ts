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

// XXX TODO remove when the issue is resolved
// https://github.com/Microsoft/TypeScript/issues/19189
import PPromise from "../../utils/promise";
import { ICompatMediaKeySystemConfiguration } from "../browser_compatibility_types";
import { ICustomMediaKeys } from "./custom_media_keys";

export interface ICustomMediaKeySystemAccess {
  readonly keySystem : string;
  getConfiguration() : ICompatMediaKeySystemConfiguration;
  createMediaKeys() : Promise<MediaKeys|ICustomMediaKeys>;
}

/**
 * Simple implementation of the MediaKeySystemAccess EME API.
 *
 * All needed arguments are given to the constructor
 * @class CustomMediaKeySystemAccess
 */
export default class CustomMediaKeySystemAccess implements ICustomMediaKeySystemAccess {
  /**
   * @param {string} _keyType
   * @param {Object} _mediaKeys
   * @param {Object} _configuration
   */
  constructor(
    private readonly _keyType : string,
    private readonly _mediaKeys : ICustomMediaKeys|MediaKeys,
    private readonly _configuration : ICompatMediaKeySystemConfiguration
  ) {}

  /**
   * @returns {string}
   */
  get keySystem() : string {
    return this._keyType;
  }

  /**
   * @returns {Promise}
   */
  public createMediaKeys() : Promise<ICustomMediaKeys|MediaKeys> {
    return new PPromise((res) => res(this._mediaKeys));
  }

  /**
   * @returns {Object}
   */
  public getConfiguration() : ICompatMediaKeySystemConfiguration {
    return this._configuration;
  }
}
