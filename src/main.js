const assert = require('assert');
const fs = require('fs');
const path = require('path');

const abnf = (options={}) => {
    const normalizeRulename = (name) => name.trim().replace(/-/g, '_');

    // required parameters
    const grammarSource = options.source || assert(false, 'missing required option: "source"');
    const startRule = normalizeRulename(options.startRule) || assert(false, 'missing required option: "startRule"');

    // optional parameters
    const languageName = options.name || path.basename(grammarSource, path.extname(grammarSource));
    const includeCoreRules = options.usesCoreRules || false;
    const hiddenRules = (options.hiddenRules || []).map(normalizeRulename);
    const inlineRules = (options.inlineRules || []).map(normalizeRulename);
    const conflicts = (options.conflicts || []).map(normalizeRulename);

    const abnfGrammar = (abnfFile) => {
	const Parser = require('tree-sitter');
	const Abnf = require('tree-sitter-abnf');

	const parser = new Parser();
	parser.setLanguage(Abnf);

	const sourceCode = fs.readFileSync(abnfFile, 'utf8');
	return parser.parse(sourceCode);
    };

    // TODO: Clean up how arguments are passed here. It may be
    // tempting to use the corresponding const values defined above,
    // but when tree-sitter suggestions are applied automatically the
    // arguments may differ.
    const toTreeSitter = (abnfTree, startRule, langName='the_language_name', includeCoreRules=true, inlineRules=[], conflicts=[], hiddenRules=[]) => {
	const unsupported = (node) => {
            console.error("\x1b[31munsupported node type: \x1b[1m" + node.type.toString() + "\t" + node.text + "\x1b[0m");
	};

	const coreRules = (!includeCoreRules)
              ? ''
              : `,
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
`;

	const inlineRuleFuncs = (node) => {
	    assert(node.type === 'source_file');
	    assert(node.children.length === 1);
	    return node
		  .firstChild
		  .descendantsOfType('rule')
		  .filter(x => {
		      const name = normalizeRulename(x.descendantsOfType('rulename')[0].text);
		      return inlineRules.includes(name);
		  })
		  .map(x => {
		      const name = normalizeRulename(x.descendantsOfType('rulename')[0].text);
		      const body = convert(x.descendantsOfType('elements')[0]);
		      return `const ${name} = $ => ${body};`
		  })
		  .join('\n');
	};

	const convert = (node) => {
            switch (node.type) {
            case 'source_file':
		assert(node.namedChildren.length === 1);
		return `
${inlineRuleFuncs(node)}

module.exports = grammar({
  name: '${langName}',

  conflicts: $ => [
    ${conflicts.join(',\n    ')}
  ],

  rules: {
    // start rule
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
		let name = convert(node.descendantsOfType('rulename')[0]);
		if (inlineRules.includes(name)) {
		    // console.log(`skipping inlined rule: ${name}`);
		    return '';
		}
		if (hiddenRules.includes(name)) {
		    name = '_' + name;
		}

		const defType = convert(node.descendantsOfType('defined_as')[0]);
		const elements = convert(node.descendantsOfType('elements')[0]);

		// TODO: support the '/=' operator
		if (defType === '/=') { unsupported(defType); }

		return `    ${name}: $ =>
      ${elements}`;
            case 'rulename':
		return normalizeRulename(node.text);
            case 'defined_as':
		return node.text.trim();
            case 'alternation':
		assert(node.namedChildren.length >= 1);
		// TODO: support interleaved comments, each followed by \r\n
		return (node.namedChildren.length === 1)
                    ? convert(node.firstNamedChild)
                    : `choice(${node.namedChildren.filter(x => x.type !== 'comment').map(convert).join(', ')})`;
            case 'concatenation':
		assert(node.namedChildren.length >= 1);
		// TODO: support interleaved comments, each followed by \r\n
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
		    let name = normalizeRulename(node.text.trim());
		    if (inlineRules.includes(name)) {
			return `${name}($)`;
		    }
		    if (hiddenRules.includes(name)) {
			name = '_' + name;
		    }
		    return `$.${name}`;
		default:
                    return convert(node.firstNamedChild);
		}
            case 'group':
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
                    return `"${hexChars}"`;
		} else if (node.children.length <= 7) {
                    assert(node.child(0).type === 'x');
                    let hexChars = '';
                    for (var i = 1; i < node.children.length; i++) {
			const x = node.child(i);
			assert(x.type === 'HEXDIG');
			hexChars = hexChars.concat(x.text);
                    }
                    return `"\\u${hexChars.padStart(4, '0')}"`;
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
    };

    return {
        grammarSource,
        startRule,
        languageName,
        includeCoreRules,
        hiddenRules,		// TODO: use this
	inlineRules,
	conflicts,

        parsedGrammar: abnfGrammar(grammarSource),

        treeSitter() { return toTreeSitter(this.parsedGrammar, this.startRule, this.languageName, this.includeCoreRules, this.inlineRules, this.conflicts, this.hiddenRules); },

        generate() {
            // TODO: Check if any of the tree-sitter* npm packages can
            // simply generate a grammar the same way as `tree-sitter
            // generate`. If so, rewrite this to avoid depending on a
            // locally installed tree-sitter-cli.

            const testDir = `./build/test/${this.languageName}`;
	    const grammarFile = `${testDir}/grammar.js`;
            if (!fs.existsSync(testDir)) {
                // NB: After stable Atom supports Node 10.x remove mkdirp
                // dependency and replace these lines.
                const mkdirp = require('mkdirp');
                mkdirp.sync(testDir);
                // fs.mkdirSync(testDir, { recursive: true });
            }
            fs.writeFileSync(`${grammarFile}`, this.treeSitter());

            console.log(`\x1b[32mGenerating tree-sitter grammar from ${grammarFile} ...\x1b[0m\n`);

            const { spawnSync } = require('child_process');
            const treeSitterResult = spawnSync('tree-sitter', ['generate'], { cwd: testDir });
            if (treeSitterResult.status === 0) {
		console.log('\x1b[32mSuccess!\x1b[0m');
		console.log(`\n\tMax line width: ${spawnSync('wc', ['-L', grammarFile]).stdout.toString()}`);
	    } else {
		const err = treeSitterResult.stderr.toString();
                console.log(`\x1b[31m${err}\x1b[0m`);


		const suggest = (msg) => console.log(`\x1b[33m\t${msg}\x1b[0m`);

		const emptyStringErr = err.match(/The rule `([^`]*)` matches the empty string./);
		const higherPrecedence = err.match(/Specify a higher precedence in `([^`]*)` than in the other rules./);
		const associativity = err.match(/Specify a left or right associativity in `([^`]*)`/);		
		const addConflict = err.match(/Add a conflict for these rules: (`.*`)/);


		// TODO: Model as a search tree with backtracking
		// instead of merely incrementally applying new
		// suggestions.

		if (emptyStringErr) {
		    suggest(`Attempting to inline rule: '${emptyStringErr[1]}'\n`);
		    this.inlineRules.push(emptyStringErr[1]);
		    this.generate();
		} else if (higherPrecedence) {
		    suggest(`Try specifying a higher precedence: '${higherPrecedence[1]}'\n`);
		} else if (associativity) {
		    suggest(`Try specifying left or right associativity: '${associativity[1]}'\n`);
		} else if (addConflict) {
		    const convertQuotedName = (name) => '$.' + normalizeRulename(name.trim().replace(/`/g, ''));
		    const conflict = '[' + addConflict[1].split(',').map(convertQuotedName).join(', ') + ']';
		    suggest(`\x1b[33mTry adding conflict: ${conflict}\x1b[0m`);
		    // TODO: automatically add conflict
		    this.conflicts.push(conflict);
		    this.generate();
		} else {
		    console.log(`\x1b[31mGiving up :(\x1b[0m`);
		}
            }

	    console.log('\n\n');
        }
    };
}

const examples = 'examples/abnf';

const postal = abnf({
    source: path.join(examples, 'postal.abnf'),
    startRule: 'postal-address',
    usesCoreRules: true,
    // hiddenRules: ['suffix', 'zip-code'],
    // inlineRules: ['first-name'],
    // conflicts: [['apt', 'house-num']]
    // conflicts: ['[ $.apt, $.house_num ]'] // TODO: support the ABNF names
});

const _abnf = abnf({
    source: path.join(examples, 'abnf.abnf'),
    startRule: 'rulelist',
    usesCoreRules: false,       // it defines them
    hiddenRules: ['c-wsp', 'c-nl', 'CR', 'CRLF', 'DQUOTE', 'HTAB', 'LF', 'SP', 'WSP']
});

const dhall = abnf({
    source: path.join(examples, 'dhall.abnf'),
    startRule: 'complete-expression',
    inlineRules: ['whitespace']
});

// postal.generate();
_abnf.generate();
// dhall.generate();
