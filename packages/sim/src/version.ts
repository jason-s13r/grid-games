// The sim's own package version, written here by dispat at each release.
//
// Its major is the protocol version. The sim's semver rule is that anything
// moving the state hash is a major release, so "the same major" and "the same
// rules" are one statement, and a client can say which games it plays by
// naming the sim release it was built with.
//
// Edited by the release, not by hand. A test holds it equal to package.json.
export const SIM_VERSION = "4.0.0";
