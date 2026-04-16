# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page browser app (no build step, no server) — open `index.html` directly in a browser. All logic lives in six files: `index.html`, `script.js`,`graph.js`,`gpuimage.js`,`gl_utils.js`, `style.css`.

There are more details about the structure of this project in docs.md. 

## External libraries (CDN, no npm)
- **jQuery 3.7.1** — required by MathQuill
- **MathQuill 0.10.1-a** — WYSIWYG math editor fields; accessed via `MQ.MathField(span, opts)`
- **MathJax 3 (`tex-svg.js`)** — renders LaTeX in the preview panel; configured for display math `\[...\]` and inline math `\(...\)`

## Guidelines

For minor ambiguity in any task — including writing code, updating docs.md, or editing CLAUDE.md — make a reasonable assumption and proceed. For anything genuinely uncertain, especially anything that would materially affect the outcome, ask the user for clarification and update docs.md accordingly. Do not make any significant design decisions yourself.

If you think there is a better way to implement something than what was asked, say so before proceeding.

Be as concise as possible. Tokens are a limited resource.

**Codebase exploration:** When directing explore agents, have them start by looking at docs.md. Instruct them to use the Project Overview subfeature index to navigate to the relevant section, then read specific code files as needed. Ideally avoid reading the entireity of docs.md at once before you know what you are looking for. You should be able to navigate through it to just find the information that you want. Start by looking under #project-overview. If you find information missing from docs.md, add it so the search doesn't need to be repeated. If docs.md is hard to navigate or search efficiently, flag it to the user.

If you are unsure how to follow a policy in this file, ask the user. After clarification, add a worked example under Policy Examples in docs.md explaining the confusion and resolution.

## docs.md

docs.md is a file containing all of the relevant information for what this code base does, how it works, and how to modify, maintain, and add to it. The purpose of this file is to act as a reference to help you understand how to edit the code or add new features without having to read through the entire code base. docs.md will be maintained entirely by you. Update it when you make a change that would substantially affect your future workflow, or that invalidates something already documented. Minor bug fixes or small style tweaks do not require a docs.md update. 


### Structure

The file should be structured hierarchically into feature sections. Any discrete piece of functionality that can be separated from its parent should be considered a feature — reusable or not. Things reused in multiple places should be their own feature section, referenced from wherever they're used rather than re-explained. For example, the equation parsing system is used in both the graphing calculator and calc boxes; it should have its own section, not be duplicated in both.

There should be a master feature called "Project Overview" which follows the feature section spec below for the whole project. This is the starting point for understanding the project and navigating docs.md.


### Feature sections
1. **Motivation:** The purpose and application of the feature. Should guide implementation decisions. If you don't have enough information to write this, ask the user.

2. **Subfeature index:** A list of all subfeatures or dependencies with links to their sections in docs.md. Allows navigating directly to a specific feature without reading through everything.

3. **Behaviour:** A high-level specification of how the feature works — what it does, not how it's implemented. Should be detailed enough that similar functionality could be reconstructed from this section alone. For UI features, describe all interactive behaviors and important characteristics. For algorithmic features, describe what the algorithm does, not the implementation details. Implementation details go in section 4.

4. **Implementation:** All relevant implementation details — key function locations, significant code patterns, anything needed to understand and modify the feature. Keep sections focused; if you're reading through a long implementation section and most of it isn't relevant, the feature should probably be split up. Don't repeat details already documented elsewhere — point to the relevant section instead.