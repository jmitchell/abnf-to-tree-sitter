const assert = require('assert');
const fs = require('fs');

const abnfGrammar = (abnfFile) => {
    const Parser = require('tree-sitter');
    const Abnf = require('tree-sitter-abnf');

    const parser = new Parser();
    parser.setLanguage(Abnf);

    const sourceCode = fs.readFileSync(abnfFile, 'utf8');
    return parser.parse(sourceCode);
}

const toTreeSitter = (abnfTree, startRule, langName='the_language_name', includeCoreRules=true) => {
    const unsupported = (node) => {
	console.error("\x1b[31munsupported node type: \x1b[1m" + node.type.toString() + "\t" + node.text + "\x1b[0m");
    };

    const rulename = (node) => {
	return node.text.replace(/-/g, "_");
    };

    let coreRules = '';
    if (includeCoreRules) {
	coreRules = coreRules.concat(`,
    // Rules defined in RFC 5234, Appendix B.
    ALPHA: $ => /[A-Za-z]/,
    BIT: $ => choice("0", "1"),
    DIGIT: $ => /[0-9]/,
    CR: $ => "\\r",
    CRLF: $ => seq($.CR, $.LF),
    DQUOTE: $ => "\\"",
    // RFC 5234 only defines upper-case HEXDIGs, but this grammar is
    // more lenient.
    HEXDIG: $ => /[0-9A-Fa-f]/,
    HTAB: $ => "\\t",
    LF: $ => "\\n",
    SP: $ => " ",
    VCHAR: $ => /[\\x21-\\x7E]/,
    WSP: $ => choice($.SP, $.HTAB)
`);
    };

    const convert = (node) => {
	switch (node.type) {
	case 'source_file':
	    assert(node.namedChildren.length === 1);
	    // TODO: expose the `source_file` rule.
	    return `
module.exports = grammar({
  name: '${langName}',

  rules: {
    source_file: $ => $.${startRule},
${convert(node.firstNamedChild)}
    ${coreRules}
  }
});`;
	case 'comment':
	    return `    // ${node.text.trimRight()}`;
	case 'rulelist':
	    return node
		.namedChildren
		.map(convert)
		.filter(x => x.trim().length !== 0)
	        // TODO: merge consecutive lines of comments so ','
	        // isn't appended to them.
		.join(',\n');
	case 'elements':
	    return node.namedChildren.map(convert);
	case 'rule':
	    const name = convert(node.descendantsOfType('rulename')[0]);
	    const defType = convert(node.descendantsOfType('defined_as')[0]);
	    const elements = convert(node.descendantsOfType('elements')[0]);

	    // TODO: support the '/=' operator
	    if (defType === '/=') { unsupported(defType); }

	    return `    ${name}: $ => 
      ${elements}`;
	case 'rulename':
	    return rulename(node);
	case 'defined_as':
	    return node.text.trim();
	case 'alternation':
	    assert(node.namedChildren.length >= 1);
	    return (node.namedChildren.length === 1)
		? convert(node.firstNamedChild)
		: `choice(${node.namedChildren.filter(x => x.type !== 'comment').map(convert).join(', ')})`;
	case 'concatenation':
	    assert(node.namedChildren.length >= 1);
	    return (node.namedChildren.length === 1)
		? convert(node.firstNamedChild)
		: `seq(${node.namedChildren.filter(x => x.type !== 'comment').map(convert).join(', ')})`;
	case 'repetition':
	    assert(node.namedChildren.length >= 1);
	    if (node.namedChildren.length === 1) {
		return convert(node.firstNamedChild);
	    }

	    assert(node.namedChildren.length === 2);
	    const repeat = node.firstNamedChild;
	    const element = convert(repeat.nextSibling);

	    const starIndex = repeat.children.findIndex(x => x.text === '*');
	    if (starIndex >= 0) {
		const lowerBound = starIndex === 0
		      ? 0
		      : parseInt(repeat.children.slice(0, starIndex).map(x => x.text).join(''));
		const upperBound = starIndex + 1 === repeat.children.length
		      ? Infinity
		      : parseInt(repeat.children.slice(starIndex + 1).map(x => x.text).join(''));
		if (upperBound === Infinity) {
		    switch (lowerBound) {
		    case 0:
			return `repeat(${element})`;
		    case 1:
			return `repeat1(${element})`;
		    default:
			return `seq(${Array(lowerBound).fill(element).join(', ')}, repeat(${element}))`;
		    }
		} else {
		    const optionals = Array(upperBound - lowerBound).fill(`optional(${element})`).join(', ');
		    return (lowerBound === 0)
			? `seq(${optionals})`
			: `seq(${Array(lowerBound).fill(element).join(', ')}, ${optionals})`
		}
	    } else {
		const n = parseInt(repeat.children.map(x => x.text).join(''));
		return `seq(${Array(n).fill(element).join(', ')})`;
	    }
	case 'option':
	    return `optional(${convert(node.firstNamedChild)})`;
	case 'element':
	    switch (node.firstNamedChild.type) {
	    case 'rulename':
	    case 'core_rulename':
		return `$.${rulename(node)}`;
	    default:
		return convert(node.firstNamedChild);
	    }
	case 'group':
	    // return "'TODO:group'"
	case 'char_val':
	case 'case_insensitive_string': // TODO: preserve case-insensitivity
	    return convert(node.firstNamedChild);
	case 'quoted_string':
	    return `${node.text.replace(/\\/g, '\\\\')}`;
	case 'num_val':
	    assert(node.children.length === 2);
	    assert(node.firstChild.type === '%');
	    return convert(node.child(1));
	case 'hex_val':
	    // TODO: Research whether the way Dhall's ABNF uses hex
	    // values is conventional (i.e. encoding (ranges of)
	    // characters), and especially whether there are other
	    // common yet incompatible interpretations.
	    if (node.children.length === 0) {
		assert(false, "ZERO children");
	    }

	    const rangeSepIndex = node.children.findIndex(x => x.type === '-');
	    if (rangeSepIndex >= 0) {
		const beforeSep = node.children.slice(0, rangeSepIndex)
		      .filter(x => x.type === 'HEXDIG')
		      .map(x => x.text)
		      .join('')
		      .padStart(4, '0');
		const afterSep = node.children.slice(rangeSepIndex + 1)
		      .filter(x => x.type === 'HEXDIG')
		      .map(x => x.text)
		      .join('')
		      .padStart(4, '0');
		return `/[\\u${beforeSep}-\\u${afterSep}]/`;		
	    } else if (node.children.length % 3 === 0) {
		let hexChars = '';
		for (var i = 0; i < node.children.length; i += 3) {
		    assert(['x', '.'].includes(node.child(i).type), node.text);
		    const x1 = node.child(i+1);
		    const x2 = node.child(i+2);
		    assert(x1.type === 'HEXDIG');
		    assert(x2.type === 'HEXDIG');
		    hexChars = hexChars.concat(`\\x${x1.text}${x2.text}`);
		}
		return `'${hexChars}'`;
	    } else if (node.children.length <= 7) {
		assert(node.child(0).type === 'x');
		let hexChars = '';
		for (var i = 1; i < node.children.length; i++) {
		    const x = node.child(i);
		    assert(x.type === 'HEXDIG');
		    hexChars = hexChars.concat(x.text);
		}
		return `'\\u${hexChars.padStart(4, '0')}'`;
	    } else {
		unsupported(node);
	    }
	// TODO: Support all the node types produced by
	// tree-sitter-abnf.
	default:
	    unsupported(node);
	}
    };

    const grammar = convert(abnfTree.rootNode);
    return grammar;
}

const test = (name, usesCoreRules, startRule) => {
    const g = abnfGrammar(`../tree-sitter-abnf/examples/${name}.abnf`);

    const testDir = `./build/test/${name}`;
    if (!fs.existsSync(testDir)) {
	// fs.mkdirSync(testDir, { recursive: true });

	// TODO: After stable Atom supports Node 10.x remove mkdirp
	// dependency and replace these lines.
	const mkdirp = require('mkdirp');
	mkdirp.sync(testDir);
    }
    fs.writeFileSync(`${testDir}/grammar.js`, toTreeSitter(g, startRule, name, usesCoreRules));

    const { spawnSync } = require('child_process');
    const treeSitterResult = spawnSync('tree-sitter', ['generate'], { cwd: testDir });
    if (treeSitterResult.status !== 0) {
	console.error(treeSitterResult.stderr.toString());
    }
};
test('postal', true, 'postal_address');
test('dhall', false, 'complete_expression');
test('abnf', false, 'rulelist');
