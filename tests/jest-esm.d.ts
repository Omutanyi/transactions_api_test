/**
 * Extends the global Jest type to include the experimental ESM API
 * `unstable_mockModule` which is available at runtime when running under
 * Jest ≥ 27 with `--experimental-vm-modules` but is not (yet) part of the
 * stable @types/jest declarations.
 */
declare namespace jest {
  /**
   * ESM-compatible module mock registration.
   * Must be called at module top-level scope (before any dynamic imports of
   * the mocked module) so that Jest's module registry replaces the real
   * module before it is linked.
   */
  function unstable_mockModule(
    moduleName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    factory: () => Record<string, any> | Promise<Record<string, any>>,
  ): void;
}
