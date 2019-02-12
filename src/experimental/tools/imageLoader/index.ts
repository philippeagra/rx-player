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

import { mapTo } from "rxjs/operators";
import { MediaSource_ } from "../../../compat/";
import QueuedSourceBuffer from "../../../core/source_buffers/queued_source_buffer";
import log from "../../../log";
import { ITrickModeTrack } from "../../../manifest/adaptation";
import arrayFind from "../../../utils/array_find";
import arrayFindIndex from "../../../utils/array_find_index";
import PPromise from "../../../utils/promise";

interface IThumbnail {
  start: number;
  duration: number;
  mediaURL: string;
}

interface IThumbnailTrack {
  thumbnails: IThumbnail[];
  init: string;
  codec: string;
}

/**
 * Fetch data from URL
 * @param {string} url
 * @returns {Observable<ArrayBuffer>}
 */
function loadArrayBufferData(url: string): Promise<ArrayBuffer> {
  return new PPromise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.responseType = "arraybuffer";
    xhr.onload = (evt: any) => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const { response } = evt.target;
        if (response instanceof ArrayBuffer) {
          resolve(response);
          return;
        }
      }
      reject("Couldn't load data.");
    };
    xhr.send();
  });
}

function resetMediaSource(
  elt : HTMLMediaElement,
  mediaSource? : MediaSource|null,
  mediaSourceURL? : string|null
) : void {
  if (mediaSource && mediaSource.readyState !== "closed") {
    const { readyState, sourceBuffers } = mediaSource;
    for (let i = sourceBuffers.length - 1; i >= 0; i--) {
      const sourceBuffer = sourceBuffers[i];
      try {
        if (readyState === "open") {
          log.info("ImageLoader: Removing SourceBuffer from mediaSource", sourceBuffer);
          sourceBuffer.abort();
        }

        mediaSource.removeSourceBuffer(sourceBuffer);
      }
      catch (e) {
        log.warn("ImageLoader: Error while disposing SourceBuffer", e);
      }
    }
    if (sourceBuffers.length) {
      log.warn("ImageLoader: Not all SourceBuffers could have been removed.");
    }
  }

  elt.src = "";
  elt.removeAttribute("src");

  if (mediaSourceURL) {
    try {
      log.debug("ImageLoader: Revoking previous URL");
      URL.revokeObjectURL(mediaSourceURL);
    } catch (e) {
      log.warn("ImageLoader: Error while revoking the media source URL", e);
    }
  }
}

function createMediaSource(elt: HTMLVideoElement): MediaSource {
  if (!MediaSource_) {
    throw new Error("");
  }

  // make sure the media has been correctly reset
  resetMediaSource(elt, null, elt.src || null);

  const mediaSource = new MediaSource_();
  const objectURL = URL.createObjectURL(mediaSource);
  elt.src = objectURL;
  return mediaSource;
}

function openMediaSource(elt: HTMLVideoElement): Promise<MediaSource> {
  return new PPromise((resolve, reject) => {
    try {
      const mediaSource = createMediaSource(elt);
      mediaSource.addEventListener("sourceopen", () => {
        resolve(mediaSource);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function prepareSourceBuffer(elt: HTMLVideoElement, codec: string): Promise<{
  mediaSource: MediaSource;
  videoSourceBuffer: QueuedSourceBuffer<any>;
  disposeMediaSource: () => void;
}> {
  return openMediaSource(elt).then((mediaSource) => {
    const sourceBuffer = mediaSource.addSourceBuffer(codec);
    return {
      mediaSource,
      videoSourceBuffer:
        new QueuedSourceBuffer("video", codec, sourceBuffer),
      disposeMediaSource: () => {
        resetMediaSource(elt, mediaSource, elt.src || null);
      },
    };
  });
}

/**
 *
 */
export default class ImageLoader {
  private readonly _videoElement : HTMLVideoElement;
  private readonly _ringBufferDepth: number;
  private  _initSegment: ArrayBuffer|null;
  private _thumbnailTrack : IThumbnailTrack|null;
  private _buffered: Array<[number, number, ArrayBuffer]>;
  private _disposeMediaSource: (() => void);
  private _videoSourceBuffer: Promise<QueuedSourceBuffer<any>>;

  private _lastTime: null|number;
  private _prmBuffer: Array<() => Promise<any>>;

  constructor(
    videoElement: HTMLVideoElement,
    trickModeTrack: ITrickModeTrack,
    ringBufferLength: number
  ) {
    this._ringBufferDepth = ringBufferLength;
    this._buffered = [];
    this._videoElement = videoElement;
    this._thumbnailTrack = null;
    this._disposeMediaSource = () => null;

    this._lastTime = null;
    this._prmBuffer = [];

    if (trickModeTrack.representations.length === 0) {
      throw new Error("ImageLoaderError: No qualities in trick mode track.");
    }

    const trackIndex = trickModeTrack.representations[0].index;

    const idxStart = trackIndex.getFirstPosition();
    const idxEnd = trackIndex.getLastPosition();
    if (idxStart != null && idxEnd != null) {
      const segments = trackIndex.getSegments(idxStart, idxEnd - idxStart);
      const currentTrack = segments
        .filter((s) => s.duration != null && s.mediaURL != null)
        .map((s) => {
          return {
            duration: (s.duration || 0) / 10000000,
            start: s.time / 10000000,
            mediaURL: s.mediaURL || "",
          };
        });
      const initSegment =
        trickModeTrack.representations[0].index.getInitSegment();
      this._thumbnailTrack = {
        thumbnails: currentTrack,
        codec: trickModeTrack.representations[0].getMimeTypeString(),
        init: initSegment ? (initSegment.mediaURL || "") : "",
      };
    } else {
      throw new Error("ImageLoaderError: Can't get segments from trick mode track.");
    }

    this._initSegment = null;

    /**
     *
     * @param {string} url
     * @param {string} codec
     * @param {Object} videoSourceBuffer
     */
    function appendInitSegment(
      url: string,
      codec: string,
      videoSourceBuffer: QueuedSourceBuffer<any>
    ): Promise<ArrayBuffer> {
      return loadArrayBufferData(url).then((e) => {
        return videoSourceBuffer.appendBuffer({
          initSegment : e,
          segment: null,
          codec,
          timestampOffset: 0,
        }).pipe(mapTo(e)).toPromise(PPromise);
      });
    }

    if (this._thumbnailTrack == null) {
      throw new Error("ImageLoaderError: No built thumbnail track.");
    }

    this._videoSourceBuffer = prepareSourceBuffer(
      this._videoElement,
      this._thumbnailTrack.codec
    ).then(({ videoSourceBuffer, disposeMediaSource }) => {
      this._disposeMediaSource = disposeMediaSource;
      if (!this._thumbnailTrack) {
        throw new Error("ImageLoaderError: No thumbnail track provided.");
      }
      const { init, codec } = this._thumbnailTrack;
      return appendInitSegment(init, codec, videoSourceBuffer).then((initSegment) => {
        this._initSegment = initSegment;
        return videoSourceBuffer;
      });
    }).catch(() => {
      throw new Error("ImageLoaderError: Couldn't open media source.");
    });

    this.flush();
  }

  /**
   *
   * @param {Object} newTrack
   */
  updateThumbnailTrack(newTrack: IThumbnailTrack): void {
    this._thumbnailTrack = newTrack;
  }

  /**
   *
   * @param {number} time
   */
  setTime(time: number): void {
    if (this._lastTime !== time) {
        const _prm = () => {
          return this._videoSourceBuffer.then((videoSourceBuffer) => {
          this._lastTime = time;
          const bufferToRemove: Array<[number, number, ArrayBuffer]> = [];
          while (this._buffered.length > this._ringBufferDepth) {
            const newBuffer = this._buffered.shift();
            if (newBuffer) {
              bufferToRemove.push(newBuffer);
            }
          }

          const removeBuffers: Array<Promise<any>> = [];
          bufferToRemove.forEach(([start, end]) => {
            const prm = videoSourceBuffer.removeBuffer(start, end)
              .toPromise(PPromise).then(() => {
                const bufferIdx = arrayFindIndex(this._buffered, ([s, e]) => {
                  return s <= time && e > time;
                });
                if (bufferIdx > -1) {
                  this._buffered.splice(bufferIdx, 1);
                }
              });
            removeBuffers.push(prm);
          });

          return PPromise.all(removeBuffers).then((_res) => {
            if (!this._thumbnailTrack) {
              log.warn("ImageLoader: No thumbnail track given.");
              return time;
            }

            const thumbnail: IThumbnail|undefined =
              arrayFind(this._thumbnailTrack.thumbnails, (t) => {
                return t.start <= time && (t.duration + t.start) > time;
              });

            if (!thumbnail) {
              log.warn("ImageLoader: Couldn't find thumbnail.");
              return time;
            }

            const bufferIdx = arrayFindIndex(this._buffered, ([start, end]) => {
              return start <= time && end > time;
            });

            const dataPrm = bufferIdx === -1 ?
              loadArrayBufferData(thumbnail.mediaURL) :
              PPromise.resolve(this._buffered[bufferIdx][2]);

            return dataPrm.then((data) => {
              return videoSourceBuffer
                .appendBuffer({
                  segment: data,
                  initSegment: this._initSegment,
                  codec: "null",
                  timestampOffset: 0,
                }).toPromise(PPromise).then(() => {
                  if (bufferIdx === -1) {
                    this._buffered.push([
                      thumbnail.start,
                      thumbnail.start + thumbnail.duration,
                      data,
                    ]);
                  }
                  this._videoElement.currentTime = time;
                  return time;
                }).catch(() => {
                  throw new Error("Couldn't append buffer.");
                });
            });
          })
          .catch((err) => {
            this.dispose();
            throw new Error("ImageLoaderError: " + err);
          });
        });
      };
      this._prmBuffer.push(_prm);
      if (this._prmBuffer.length > 2) {
        // Keep only last 2 promises
        this._prmBuffer.shift();
      }
    }
  }

  /**
   *
   */
  dispose(): any {
    return this._videoSourceBuffer.then(() => {
      if (this._prmBuffer.length > 0) {
        setTimeout(() => {
          this.dispose();
        }, 100);
      } else {
        this._initSegment = null;
        this._thumbnailTrack = null;
        this._buffered = [];
        this._disposeMediaSource();
      }
    });
  }

  private flush(): void {
    const prm = this._prmBuffer.shift();
    if (prm) {
      prm().then(() => {
        this.flush();
      });
    } else {
      setTimeout(() => {
        this.flush();
      }, 100);
    }
  }
}
