import noFloatPrice from './rules/no-float-price.js';
import noVenueLiteral from './rules/no-venue-literal.js';
import reservedIdentifiers from './rules/reserved-identifiers.js';

const plugin = {
  meta: {
    name: 'eslint-plugin-wsr',
    version: '0.0.1',
  },
  rules: {
    'reserved-identifiers': reservedIdentifiers,
    'no-float-price': noFloatPrice,
    'no-venue-literal': noVenueLiteral,
  },
};

export default plugin;
