// Content script entry point — webpack builds this into content.js.
// The manifest's content_scripts[0].js references content.js, and the
// browser loads this module at run_at: "document_start" on every page.
//
// During the factory-refactor migration (steps 2-4), this file also
// initializes the legacy compat shim's default instance by importing
// the module for side effect. Step 5 removes the compat layer and
// this entry becomes a plain `createContentScript().initialize()`.
import { createContentScript } from './content';

createContentScript().initialize();
