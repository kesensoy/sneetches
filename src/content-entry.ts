// Content script entry point — webpack builds this into content.js.
// The manifest's content_scripts[0].js references content.js, and the
// browser loads this module at run_at: "document_start" on every page.
import { createContentScript } from './content';

createContentScript().initialize();
