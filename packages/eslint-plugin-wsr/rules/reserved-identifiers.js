import { RESERVED_NAMES_LOWERCASE, TYPE_ONLY_RESERVED_NAMES, VALUE_EXEMPT_NAMES } from '../reserved-names.js';

// Type-only reserved names (Ms, Ticks, Lots, Side, Buckets, PivotKind) are
// checked only against type-position declarations: a field or variable
// holding a value of one of these types legitimately uses the plain
// lowercase word (e.g. `readonly side: Side` in the §3.0 Pivot interface).
const TYPE_DECLARATION_SELECTORS = [
  'TSTypeAliasDeclaration > Identifier.id',
  'TSInterfaceDeclaration > Identifier.id',
  'TSEnumDeclaration > Identifier.id',
];

// Every other reserved name (classes, functions, constants, non-type fields)
// is checked against every non-type-position declaration kind.
const VALUE_DECLARATION_SELECTORS = [
  'VariableDeclarator > Identifier.id',
  'FunctionDeclaration > Identifier.id',
  'FunctionExpression > Identifier.id',
  'ClassDeclaration > Identifier.id',
  'TSEnumMember > Identifier.id',
  'PropertyDefinition > Identifier.key',
  'TSPropertySignature > Identifier.key',
  'Property > Identifier.key',
];

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Reserved strategy.md identifiers must be used verbatim (same case) as declared identifiers.',
    },
    schema: [],
    messages: {
      wrongCase:
        "'{{name}}' matches the reserved spec identifier '{{canonical}}' case-insensitively but not exactly; use '{{canonical}}' verbatim.",
    },
  },
  create(context) {
    function checkAgainstAllReserved(node) {
      const name = node.name;
      const canonical = RESERVED_NAMES_LOWERCASE.get(name.toLowerCase());
      if (canonical !== undefined && name !== canonical) {
        context.report({ node, messageId: 'wrongCase', data: { name, canonical } });
      }
    }

    function checkAgainstValueReserved(node) {
      const name = node.name;
      if (VALUE_EXEMPT_NAMES.has(name)) {
        return;
      }
      const canonical = RESERVED_NAMES_LOWERCASE.get(name.toLowerCase());
      if (canonical !== undefined && name !== canonical && !TYPE_ONLY_RESERVED_NAMES.has(canonical)) {
        context.report({ node, messageId: 'wrongCase', data: { name, canonical } });
      }
    }

    const visitor = {};
    for (const selector of TYPE_DECLARATION_SELECTORS) {
      visitor[selector] = checkAgainstAllReserved;
    }
    for (const selector of VALUE_DECLARATION_SELECTORS) {
      visitor[selector] = checkAgainstValueReserved;
    }
    return visitor;
  },
};

export default rule;
