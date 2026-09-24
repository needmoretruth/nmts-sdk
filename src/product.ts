// What this package is. Pure constants, so anything may import them without loading the rest.

export const SDK_NAME = "@needmoretruth/nmts-sdk";

/**
 * The version this code says it is.
 *
 * ⛔ KEPT IN STEP WITH `package.json` BY HAND, for the same reason the command-line tool keeps two
 *    copies: an installed package cannot read its own manifest from every place it may be loaded,
 *    and a program that reports the wrong version makes every defect report about it untrustworthy.
 */
export const VERSION = "0.12.0";

export const HOME_URL = "https://nmts.me";
export const SOURCE_URL = "https://github.com/needmoretruth/nmts-sdk";
