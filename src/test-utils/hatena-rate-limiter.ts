/**
 * hatena モジュール内のレートリミッター状態をテスト用に操作するユーティリティ。
 *
 * 本番コードからは import しない (test ファイルのみが使う) ことで、
 * `_setSleepForTest` 系の関数が production bundle に混入するのを防ぐ。
 */

import {
  _getRateLimiterStateForTest as _state,
  _resetRateLimiterForTest as _reset,
  _setRandomForTest as _setRandom,
  _setSleepForTest as _setSleep,
} from '../services/hatena.js';

export const _getRateLimiterStateForTest = _state;
export const _resetRateLimiterForTest = _reset;
export const _setRandomForTest = _setRandom;
export const _setSleepForTest = _setSleep;
