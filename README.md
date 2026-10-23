# Octonet

![Github Actions](https://github.com/noxecane/octonet/actions/workflows/build-test.yml/badge.svg)
[![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg?style=flat-square)](https://github.com/prettier/prettier)

## About

octonet is a library that provides utility functions for building microservices such as:

- Interservice communication (via REST)
- Subscribing to events from NATS servers.
- Logging
- Authentication

## Getting Started

These instructions will get you a copy of the project up and running on your local machine for development purposes.

### Prerequisites

The following are required for the best use of Octonet:

- Package Dependencies
  - NodeJs (v14 or higher)
  - Yarn
  - Typescript (v4.4 or higher)

### Installation

To install Octonet, run the following command in your terminal

```bash
yarn install --save @noxecane/octonet
```

To upgrade to a specific version run this command

```bash
yarn upgrade @noxecane/octonet@version
```

To upgrade to latest version run this command

```bash
yarn upgrade @noxecane/octonet --latest
```

> Note: Octonet's NATS handlers use decorators, and its typings need Node-style module resolution. Your
> `tsconfig.json` needs:

```json
{
  "compilerOptions": {
    "module": "node16",
    "moduleResolution": "node16",
    "experimentalDecorators": true
  }
}
```

## Guides

Below are links to detailed explanations to the various features of Octonet as well as practical examples:

- [HTTP (Interservice Comunication)](docs/HTTP.md)
- [NATS (streams, publishing and consuming)](docs/NATS.md)
- [Authentication](docs/Authentication.md)
- [Logging](docs/Logging.md)

## References and Helpful Links

The following links would further aid the understanding of Octonet

- [Typescript Decorators](https://www.typescriptlang.org/docs/handbook/decorators.html)
- [Bunyan](https://github.com/trentm/node-bunyan#readme)
- [Axios](https://axios-http.com/docs/intro)
- [NATS Messaging](https://docs.nats.io/nats-concepts/what-is-nats)
