const VENUE_IDS = new Set(['binance', 'bybit', 'okx', 'bitget', 'gate', 'kucoin']);
const EXEMPT_PATH_SEGMENT = 'packages/data/src/venues/';
// Spec §1.4/§8.2: @wsr/core must not import @wsr/data's VenueId (dependency
// direction), so config.ts is required to duplicate the six venue ids locally
// as the canonical literal tuple. This is the one other sanctioned site.
const EXEMPT_PATH_SUFFIX = 'packages/core/src/config.ts';

function isExempt(filename) {
  const normalized = filename.replace(/\\/g, '/');
  return normalized.includes(EXEMPT_PATH_SEGMENT) || normalized.endsWith(EXEMPT_PATH_SUFFIX);
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Bans string literals equal to a venue id ('binance'|'bybit'|'okx'|'bitget'|'gate'|'kucoin') outside packages/data/src/venues/**.",
    },
    schema: [],
    messages: {
      noVenueLiteral:
        "'{{value}}' is a venue-id literal; venue names may only appear inside packages/data/src/venues/**.",
    },
  },
  create(context) {
    if (isExempt(context.filename ?? context.getFilename())) {
      return {};
    }

    return {
      Literal(node) {
        if (typeof node.value === 'string' && VENUE_IDS.has(node.value)) {
          context.report({ node, messageId: 'noVenueLiteral', data: { value: node.value } });
        }
      },
    };
  },
};

export default rule;
