// Exempt file: the decimal-parsing helper is the one place allowed to do
// string-to-number coercion, per Spec §3.11 ("never by parseFloat(price)/tick").
const EXEMPT_PATH_SUFFIX = 'core/src/numerics.ts';

function isExempt(filename) {
  return filename.replace(/\\/g, '/').endsWith(EXEMPT_PATH_SUFFIX);
}

// Spec §3.11 "no float price is ever compared". `Ticks` is a plain `number`
// alias, which the TypeScript checker erases, so a type-aware rule cannot see
// it (A-120). The check is syntactic instead: a price operand is a name
// annotated `Ticks` in the same file, or one of the cross-package `Ticks`
// fields below; a float operand is a fractional literal, a `/` quotient or a
// transcendental `Math` call not wrapped in an integer conversion.
const TICKS_FIELDS = new Set([
  'p', 'price', 'WickLevel', 'SweepExtreme', 'SweepRunningMax', 'StopLoss', 'Target', 'TriggerPrice',
  'EntryFill', 'FillPrice', 'LegExtreme', 'Anchor', 'High_k', 'Low_k', 'BandEdge',
]);

const FLOAT_MATH = new Set([
  'sqrt', 'cbrt', 'exp', 'expm1', 'log', 'log1p', 'log2', 'log10', 'pow', 'hypot', 'random',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh',
]);

const COMPARISON = new Set(['<', '>', '<=', '>=', '===', '!==', '==', '!=']);

function isTicksType(annotation) {
  const t = annotation?.typeAnnotation;
  if (t === undefined) return false;
  const ref = (x) => x.type === 'TSTypeReference' && x.typeName.type === 'Identifier' && x.typeName.name === 'Ticks';
  return ref(t) || (t.type === 'TSUnionType' && t.types.some(ref));
}

// Names declared with a `Ticks` annotation anywhere in the file.
function collectTicksNames(ast, visitorKeys) {
  const names = new Set();
  const visit = (node) => {
    if (node === null || typeof node !== 'object' || typeof node.type !== 'string') return;
    if (node.type === 'Identifier' && isTicksType(node.typeAnnotation)) names.add(node.name);
    if ((node.type === 'PropertyDefinition' || node.type === 'TSPropertySignature') && node.key.type === 'Identifier' && isTicksType(node.typeAnnotation)) {
      names.add(node.key.name);
    }
    for (const key of visitorKeys[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(ast);
  return names;
}

function isFloat(node) {
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'number' && !Number.isInteger(node.value);
    case 'BinaryExpression':
      return node.operator === '/' || (['+', '-', '*'].includes(node.operator) && (isFloat(node.left) || isFloat(node.right)));
    case 'UnaryExpression':
      return node.operator === '-' && isFloat(node.argument);
    case 'CallExpression': {
      const c = node.callee;
      return c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier' && c.object.name === 'Math' &&
        c.property.type === 'Identifier' && FLOAT_MATH.has(c.property.name);
    }
    case 'TSAsExpression':
    case 'TSNonNullExpression':
      return isFloat(node.expression);
    default:
      return false;
  }
}

function isTicks(node, names) {
  switch (node.type) {
    case 'Identifier':
      return names.has(node.name);
    case 'MemberExpression':
      return !node.computed && node.property.type === 'Identifier' && (TICKS_FIELDS.has(node.property.name) || names.has(node.property.name));
    case 'BinaryExpression':
      return ['+', '-', '*'].includes(node.operator) && (isTicks(node.left, names) || isTicks(node.right, names));
    case 'UnaryExpression':
      return node.operator === '-' && isTicks(node.argument, names);
    case 'TSAsExpression':
    case 'TSNonNullExpression':
      return isTicks(node.expression, names);
    default:
      return false;
  }
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Bans parseFloat/Number.parseFloat/unary + string-to-number coercion outside core/src/numerics.ts, and comparisons of a Ticks price with a float expression.',
    },
    schema: [],
    messages: {
      noParseFloat: 'parseFloat/Number.parseFloat is banned outside core/src/numerics.ts; parse prices as exact decimal-string BigInt division instead.',
      noUnaryPlus: 'Unary "+" string-to-number coercion is banned outside core/src/numerics.ts; parse prices as exact decimal-string BigInt division instead.',
      noFloatCompare: 'Ticks price compared with a float expression; convert to Ticks first (floorTicksConservative / ceilTicksConservative, Spec §3.11).',
    },
  },
  create(context) {
    if (isExempt(context.filename ?? context.getFilename())) {
      return {};
    }
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    let names = null;

    return {
      Program(node) {
        names = collectTicksNames(node, sourceCode.visitorKeys);
      },
      BinaryExpression(node) {
        if (!COMPARISON.has(node.operator)) return;
        if ((isTicks(node.left, names) && isFloat(node.right)) || (isTicks(node.right, names) && isFloat(node.left))) {
          context.report({ node, messageId: 'noFloatCompare' });
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        const isParseFloatIdentifier = callee.type === 'Identifier' && callee.name === 'parseFloat';
        const isNumberParseFloat =
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'Number' &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'parseFloat';
        if (isParseFloatIdentifier || isNumberParseFloat) {
          context.report({ node, messageId: 'noParseFloat' });
        }
      },
      'UnaryExpression[operator="+"]'(node) {
        const argument = node.argument;
        const isNumericLiteral = argument.type === 'Literal' && typeof argument.value === 'number';
        if (!isNumericLiteral) {
          context.report({ node, messageId: 'noUnaryPlus' });
        }
      },
    };
  },
};

export default rule;
