/**
 * Just enough of Electron's renderer API to open a folder in the file manager.
 * Declared locally so the plugin does not need the full electron package as a
 * dev dependency — Obsidian provides the module at runtime.
 */
declare module 'electron' {
  export const shell: {
    /** Resolves to an empty string on success, or an error message. */
    openPath(path: string): Promise<string>;
  };
}
