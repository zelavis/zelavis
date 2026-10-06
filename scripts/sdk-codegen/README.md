# Experimental OpenAPI client generation

The official JavaScript/TypeScript client ships in the `zelavis` npm package:
`zelavis/sdk`, `zelavis/sdk/browser`, and `zelavis/sdk/node`. Its source is in
`packages/zelavis/src/sdk`; this directory does not contain another JS SDK.

The Python, Java, C#, and Rust YAML files are draft OpenAPI Generator recipes.
There are no implemented, tested, or published cross-language SDKs here. Their
package versions are placeholders, not Zelavis compatibility or release claims.

Keep these recipes beside the API while its contracts evolve. A real client can
remain in this monorepo with language-specific tests and release tooling. Split
it into a separate repository when ownership and release cadence justify that
cost; a different language alone does not require a separate repository.

## Manual experiment

Run from the repository root, against a running local Zelavis instance. Set
`ZELAVIS_ORIGIN` to that instance's origin, including its actual port. Use a
qualified, explicitly installed version of
[OpenAPI Generator](https://openapi-generator.tech/docs/usage/); the repository
does not download a generator or generate clients during install, development,
build, or CI.

```bash
mkdir -p scripts/sdk-codegen/generated
curl --fail --silent --show-error \
  "${ZELAVIS_ORIGIN:?Set the local Zelavis origin}/zelavis/api/v1/runtime/openapi.json" \
  --output scripts/sdk-codegen/generated/zelavis-api.json

openapi-generator-cli generate \
  --input-spec scripts/sdk-codegen/generated/zelavis-api.json \
  --config scripts/sdk-codegen/openapi-config/python.yaml \
  --output scripts/sdk-codegen/generated/python
```

Select the corresponding config and output directory for another language.
Generated specs and clients stay in Git-ignored `generated/`. Inspect the actual
OpenAPI 3.1 document, generator support, authentication, Project/Tenant scoping,
error handling, and compatibility with the target Platform before using or
publishing a client. Installed services contribute to that instance's document,
so an experimental export is not a canonical, versioned SDK contract.
