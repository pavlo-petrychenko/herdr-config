#!/usr/bin/env node
// herdr-prs entry point. The commands are in lib/main.mjs; see FORMAT.md for the data file.
import { main } from "./lib/main.mjs";

process.exitCode = await main(process.argv.slice(2));
