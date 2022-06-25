<a href="https://github.com/open-flash/open-flash">
    <img src="https://raw.githubusercontent.com/open-flash/open-flash/master/logo.png"
    alt="Open Flash logo" title="Open Flash" align="right" width="64" height="64" />
</a>

# AVM1 Emitter

[![GitHub repository](https://img.shields.io/badge/GitHub-open--flash%2Favm1--emitter-informational.svg)](https://github.com/open-flash/avm1-emitter)
<a href="https://crates.io/crates/avm1-emitter"><img src="https://img.shields.io/crates/v/avm1-emitter" alt="crates.io crate"/></a>
<a href="https://github.com/open-flash/avm1-emitter/actions/workflows/check-rs.yml"><img src="https://img.shields.io/github/workflow/status/open-flash/avm1-emitter/check-rs/main"  alt="Rust checks status"/></a>
<a href="https://docs.rs/avm1-emitter"><img src="https://img.shields.io/badge/docs.rs-avm1--emitter-informational" alt="docs.rs/avm1-emitter"></a>

AVM1 emitter implemented in Rust.
Converts [`avm1-types` control flow graphs][avm1-types] to bytes.

## Usage

TODO

## Contributing

This repo uses Git submodules for its test samples:

```sh
# Clone with submodules
git clone --recurse-submodules git://github.com/open-flash/avm1-emitter.git
# Update submodules for an already-cloned repo
git submodule update --init --recursive --remote
```

This library is a standard Cargo project. You can test your changes with
`cargo test`.

Prefer non-`master` branches when sending a PR so your changes can be rebased if
needed. All the commits must be made on top of `master` (fast-forward merge).
CI must pass for changes to be accepted.

[avm1-types]: https://github.com/open-flash/avm1-types
