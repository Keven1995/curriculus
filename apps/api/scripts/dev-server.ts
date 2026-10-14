// Set development defaults only for the explicit dev command. The production entry point
// never assumes that a missing NODE_ENV means development.
process.env.NODE_ENV ??= "development";
await import("../src/index.js");
