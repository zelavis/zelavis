# Contributing to AppHead

'/packages/authentication/src/expirements'

# In this folder go test implementations of lucia for other web frameworks in case we consider some day in the future to switch the web framework. Why? -

(we want to build the platform in a way that does not lock us into other ecosystems).

# This is also the place to test other authentication methods and alternative libraries to the current one (always try to improve the platform, never stop!).

The Apphead Core is under '/packages/core' ('@apphead/core'), it includes other packages which are part of the core, these packages are,
'/packages/js-sdk'
'/packages/storage'
'/packages/ui'

The package 'storage' is the storage engine and the reason it is part of the core is obvious, but what about 'js-sdk' why is the SDK which is also used by the users of Apphead to interact with the backend also part of the core? The reason for this is pretty easy because AppHead UI (The Dashboard) is also part of the core and it uses the 'js-sdk' to interact with the backend.

Now we know what all the packages do except for one ('packages/apphead'), so what is the apphead package? It is the server that uses only one other package and that package is 'packages/core'. As you might have guessed it is the main package that is distributed to the package managers and used by the end users. As you can see the server is not a core part of Apphead and everyone can build their version of Apphead with a custom server by using any server like (Hono, Fastify, or Express) and installing '@apphead/core' which includes everything from storage API's to the user-interface and glue everything together.

## Repository

-packages/apphead
server + core which is published to NPM & Co.

-packages/js-sdk
the javascript sofware developent kit for end users of apphead for interacting with the backend, it also handels client side caching.

-packages/storage
the storage & caching engine

-packages/ui
this is the user interface which is also a part of '/core' but kept a seperate package in the repo for easier development, when building the ui for production the production folder for gets moved into 'packages/apphead/dist_ui'.

# PUBLISHING TO NPM

AppHead is a modern TypeScript & PNPM Wokspace repository which is easy to understand and contribute to.
When changes are made and merged into the repository all we need to do is update versions of each modified package and publish to npm and do `npm i` and then `npm publish` the new version of "AppHead"

# Contribute to SDKs

# General

Every SDK comes with a Local Database which makes AppHead offline first and allows Developers to use Apphead also for Application which don't need a Hosted Database, so if you are building for example a WIN/MAC/Linux/Android/IOS App which will never need a Hosted Database then the SDK for your Language is all you need to use AppHead. On the other hand if you build Application which need both it also allows for interaction with the Hosted Database/Clusters and local to cloud data sync that means every write to the database without internet connections will be synced when the connection is back.

# Contribute to node-sdk - /packages/SDKs/node-sdk

The Node & Deno SDKs need to have the exact same codebase except for the module imports and they are published diffrently.

# Contribute to deno-sdk - /packages/SDKs/deno-sdk

This is a deno project and is not tracked by the Workspace feature of npm as you can see under ./package.json.
The Node & Deno SDKs need to have the exact same codebase except for the module imports and they are published diffrently.

# Contribute to web-sdk - /packages/SDKs/web-sdk

This is a deno project and is not tracked by the Workspace feature of npm as you can see under ./package.json.
The Node & Deno SDKs need to have the exact same codebase except for the module imports and they are published diffrently.

# Contribute to Panel - /packages/panel

The AppHead Panel is a Next.js Application which uses SSR only, since the AppHead Server is a Backend built on Fastify the way Next.js is integrated is trough a Fastify plugin which uses the Next.js Custom Server, https://nextjs.org/docs/advanced-features/custom-server. The Panel istself is a Fastify plugin aswell which is published to NPM @AppHead/panel and used in @AppHead/core.

# Contribute to Core
