/**
 * Hatena モジュール内のレートリミッター状態をテスト用に操作するユーティリティ。
 *
 * 本番コードからは import しない (test ファイルのみが使う) ことで、
 * `_setSleepForTest` 系の関数が production bundle に混入するのを防ぐ。
 */

import {
  _resetRateLimiterForTest as _reset,
  _setRandomForTest as _setRandom,
  _setSleepForTest as _setSleep,
  _getRateLimiterStateForTest as _state,
} from '../services/hatena.js';

export const _getRateLimiterStateForTest = _state;
export const _resetRateLimiterForTest = _reset;
export const _setRandomForTest = _setRandom;
export const _setSleepForTest = _setSleep;
