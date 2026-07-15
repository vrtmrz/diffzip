# Repository instructions

## Release validation boundaries

- Before requiring BRAT or real-device validation, assess whether the changed consumer behaviour and failure paths are sufficiently covered by mocks or injected tests, whether unchanged Fancy Kit behaviour is already guaranteed by its contract and E2E suite, and what device-specific behaviour remains unverified. Base the release gate on that assessment instead of repeating upstream tests.
- Keep DiffZip-owned restore, Vault, storage, and workflow composition behind explicit test boundaries. Rely on Fancy Kit tests only for behaviour owned by the Kit contract; add consumer tests wherever DiffZip composes, interprets, or persists the result.
- When automated coverage is sufficient for users, prepare an `x.y.z` plug-in version and publish its immutable tag initially as a GitHub pre-release for BRAT installation. After validation, remove the pre-release designation and merge the exact reviewed release commit into `main`. If validation fails, keep the published tag unchanged and prepare the next patch version.
