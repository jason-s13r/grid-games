// The sim's own package version, written here by dispat at each release.
//
// Its major is the protocol version. The sim's semver rule is that anything
// moving the state hash is a major release, so "the same major" and "the same
// rules" are one statement, and a client can say which games it plays by
// naming the sim release it was built with.
//
// Written by dispat at each release, along with package.json. Between releases
// it may be ahead of the manifest: a major pinned with Release-As is in force
// here from the commit that pins it, so builds made before the release already
// play the protocol the release will publish.
export const SIM_VERSION = "5.2.0";
