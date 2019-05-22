/**
 * @license Copyright 2019 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * @fileoverview A collection of eslint rules written specifically for
 * Lighthouse. These are included by the eslint-plugin-local-rules plugin.
 */

/** @typedef {import('eslint').Rule.RuleModule} RuleModule */

/**
 * An eslint rule ensuring that any require() of a local path (aka not a core
 * module or a module dependency) includes a file extension (.js' or '.json').
 * @type {RuleModule}
 */
const requireFileExtension = {
  meta: {
    docs: {
      description: 'disallow require() without a file extension',
      category: 'Best Practices',
      recommended: false,
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        // Only look at instances of `require(moduleName: string)`.
        if (node.type !== 'CallExpression') return;
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') return;
        if (!node.arguments.length) return;
        const arg0 = node.arguments[0];
        if (arg0.type !== 'Literal' || typeof arg0.value !== 'string') return;

        // If it's a local file, it must have a file extension.
        const filename = arg0.value;
        if (!filename.startsWith('.')) return;
        if (filename.endsWith('.js') || filename.endsWith('.json')) return;

        context.report({
          node: node,
          message: 'Required path must have a file extension.',
        });
      },
    };
  },
};

module.exports = {
  'require-file-extension': requireFileExtension,
};
