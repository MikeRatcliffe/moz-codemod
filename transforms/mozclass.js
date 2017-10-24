/**
 * Copyright 2013-2015, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 */

'use strict';

const { basename, extname, dirname } = require('path');

module.exports = (file, api, options) => {
  const j = api.jscodeshift;

  require('./utils/array-polyfills');
  const ReactUtils = require('./utils/ReactUtils')(j);

  const printOptions =
    options.printOptions || {
      quote: 'single',
      trailingComma: true,
      flowObjectCommas: true,
      arrowParensAlways: true,
      arrayBracketSpacing: false,
      objectCurlySpacing: false,
    };

  var root = j(file.source);

  // retain top comments
  const { comments: topComments } = root.find(j.Program).get('body', 0).node;

  const AUTOBIND_IGNORE_KEYS = {
    componentDidMount: true,
    componentDidUpdate: true,
    componentWillReceiveProps: true,
    componentWillMount: true,
    componentWillUpdate: true,
    componentWillUnmount: true,
    getChildContext: true,
    getDefaultProps: true,
    getInitialState: true,
    render: true,
    shouldComponentUpdate: true,
  };

  const DEFAULT_PROPS_FIELD = 'getDefaultProps';
  const DEFAULT_PROPS_KEY = 'defaultProps';
  const GET_INITIAL_STATE_FIELD = 'getInitialState';

  const DEPRECATED_APIS = [
    'getDOMNode',
    'isMounted',
    'replaceProps',
    'replaceState',
    'setProps',
  ];

  const PURE_MIXIN_MODULE_NAME = options['mixin-module-name'] ||
    'react-addons-pure-render-mixin';

  const CREATE_CLASS_MODULE_NAME = options['create-class-module-name'] ||
    'create-react-class';

  const CREATE_CLASS_VARIABLE_NAME = options['create-class-variable-name'] ||
    'createReactClass';

  const STATIC_KEY = 'statics';

  const STATIC_KEYS = {
    childContextTypes: true,
    contextTypes: true,
    displayName: true,
    propTypes: true,
  };

  const MIXIN_KEY = 'mixins';

  const NO_CONVERSION = options.conversion === false;
  const STATIC_GETTERS = typeof options['static-getters'] === "undefined" ||
                         options['static-getters'] === true

  const NO_DISPLAY_NAME = options['display-name'] === false;

  let shouldTransformFlow = false;

  if (options['flow']) {
    const programBodyNode = root.find(j.Program).get('body', 0).node;
    if (programBodyNode && programBodyNode.comments) {
      programBodyNode.comments.forEach(node => {
        if (node.value.indexOf('@flow') !== -1) {
          shouldTransformFlow = true;
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  const createFindPropFn = prop => property => (
    property.key &&
    property.key.type === 'Identifier' &&
    property.key.name === prop
  );

  const filterDefaultPropsField = node =>
    createFindPropFn(DEFAULT_PROPS_FIELD)(node);

  const filterGetInitialStateField = node =>
    createFindPropFn(GET_INITIAL_STATE_FIELD)(node);

  const findGetInitialState = specPath =>
    specPath.properties.find(createFindPropFn(GET_INITIAL_STATE_FIELD));

  const withComments = (to, from) => {
    to.comments = from.comments;
    return to;
  };

  const isPrimExpression = node => (
    node.type === 'Literal' || ( // NOTE this might change in babylon v6
      node.type === 'Identifier' &&
      node.name === 'undefined'
  ));

  const isFunctionExpression = node => (
    node.key &&
    node.key.type === 'Identifier' &&
    node.value &&
    node.value.type === 'FunctionExpression'
  );

  const isPrimProperty = prop => (
    prop.key &&
    prop.key.type === 'Identifier' &&
    prop.value &&
    isPrimExpression(prop.value)
  );

  const isPrimPropertyWithTypeAnnotation = prop => (
    prop.key &&
    prop.key.type === 'Identifier' &&
    prop.value &&
    prop.value.type === 'TypeCastExpression' &&
    isPrimExpression(prop.value.expression)
  );

  const hasSingleReturnStatement = value => (
    (
      value.type === 'ArrowFunctionExpression' &&
      value.body &&
      value.body.type === 'ObjectExpression'
    ) || (
      (
        value.type === 'FunctionExpression' || value.type === 'ArrowFunctionExpression'
      ) &&
      value.body &&
      value.body.type === 'BlockStatement' &&
      value.body.body &&
      value.body.body.length === 1 &&
      value.body.body[0].type === 'ReturnStatement' &&
      value.body.body[0].argument
    )
  );

  const getComponentNameFromArgs = args => {
    for (let n of args) {
      for (let prop of n.properties) {
        if (prop.key.name === "displayName") {
          return prop.value.value;
        }
      }
    }

    return "";
  }

  // ---------------------------------------------------------------------------
  // Checks if the module uses mixins or accesses deprecated APIs.
  const checkDeprecatedAPICalls = classPath =>
    DEPRECATED_APIS.reduce(
      (acc, name) =>
        acc + j(classPath)
          .find(j.Identifier, {name})
          .size(),
      0
    ) > 0;

  const hasNoCallsToDeprecatedAPIs = classPath => {
    if (checkDeprecatedAPICalls(classPath)) {
      console.warn(
        file.path + ': `' + ReactUtils.directlyGetComponentName(classPath) + '` ' +
        'was skipped because of deprecated API calls. Remove calls to ' +
        DEPRECATED_APIS.join(', ') + ' in your React component and re-run ' +
        'this script.'
      );
      return false;
    }
    return true;
  };

  const hasNoRefsToAPIsThatWillBeRemoved = classPath => {
    const hasInvalidCalls = (
      j(classPath).find(j.MemberExpression, {
        object: {type: 'ThisExpression'},
        property: {name: DEFAULT_PROPS_FIELD},
      }).size() > 0 ||
      j(classPath).find(j.MemberExpression, {
        object: {type: 'ThisExpression'},
        property: {name: GET_INITIAL_STATE_FIELD},
      }).size() > 0
    );

    if (hasInvalidCalls) {
      console.warn(
        file.path + ': `' + ReactUtils.directlyGetComponentName(classPath) + '` ' +
        'was skipped because of API calls that will be removed. Remove calls to `' +
        DEFAULT_PROPS_FIELD + '` and/or `' + GET_INITIAL_STATE_FIELD +
        '` in your React component and re-run this script.'
      );
      return false;
    }
    return true;
  };

  const doesNotUseArguments = classPath => {
    const hasArguments = (
      j(classPath).find(j.Identifier, {name: 'arguments'}).size() > 0
    );
    if (hasArguments) {
      console.warn(
        file.path + ': `' + ReactUtils.directlyGetComponentName(classPath) + '` ' +
        'was skipped because `arguments` was found in your functions. ' +
        'Arrow functions do not expose an `arguments` object; ' +
        'consider changing to use ES6 spread operator and re-run this script.'
      );
      return false;
    }
    return true;
  };

  const isGetInitialStateConstructorSafe = getInitialState => {
    if (!getInitialState) {
      return true;
    }

    const collection = j(getInitialState);
    let result = true;

    const propsVarDeclarationCount = collection.find(j.VariableDeclarator, {
      id: {name: 'props'},
    }).size();

    const contextVarDeclarationCount = collection.find(j.VariableDeclarator, {
      id: {name: 'context'},
    }).size();

    if (
      propsVarDeclarationCount &&
      propsVarDeclarationCount !== collection.find(j.VariableDeclarator, {
        id: {name: 'props'},
        init: {
          type: 'MemberExpression',
          object: {type: 'ThisExpression'},
          property: {name: 'props'},
        }
      }).size()
    ) {
      result = false;
    }

    if (
      contextVarDeclarationCount &&
      contextVarDeclarationCount !== collection.find(j.VariableDeclarator, {
        id: {name: 'context'},
        init: {
          type: 'MemberExpression',
          object: {type: 'ThisExpression'},
          property: {name: 'context'},
        }
      }).size()
    ) {
      result = false;
    }

    return result;
  };

  const isInitialStateConvertible = classPath => {
    const specPath = ReactUtils.directlyGetCreateClassSpec(classPath);
    if (!specPath) {
      return false;
    }
    const result = isGetInitialStateConstructorSafe(findGetInitialState(specPath));
    if (!result) {
      console.warn(
        file.path + ': `' + ReactUtils.directlyGetComponentName(classPath) + '` ' +
        'was skipped because of potential shadowing issues were found in ' +
        'the React component. Rename variable declarations of `props` and/or `context` ' +
        'in your `getInitialState` and re-run this script.'
      );
    }
    return result;
  };

  const canConvertToClass = classPath => {
    const specPath = ReactUtils.directlyGetCreateClassSpec(classPath);
    if (!specPath) {
      return false;
    }
    const invalidProperties = specPath.properties.filter(prop => (
      !prop.key.name || (
        !STATIC_KEYS.hasOwnProperty(prop.key.name) &&
        STATIC_KEY != prop.key.name &&
        !filterDefaultPropsField(prop) &&
        !filterGetInitialStateField(prop) &&
        !isFunctionExpression(prop) &&
        !isPrimProperty(prop) &&
        !isPrimPropertyWithTypeAnnotation(prop) &&
        MIXIN_KEY != prop.key.name
      )
    ));

    if (invalidProperties.length) {
      const invalidText = invalidProperties
        .map(prop => prop.key.name ? prop.key.name : prop.key)
        .join(', ');
      console.warn(
        file.path + ': `' + ReactUtils.directlyGetComponentName(classPath) + '` ' +
        'was skipped because of invalid field(s) `' + invalidText + '` on ' +
        'the React component. Remove any right-hand-side expressions that ' +
        'are not simple, like: `componentWillUpdate: createWillUpdate()` or ' +
        '`render: foo ? renderA : renderB`.'
      );
    }
    return !invalidProperties.length;
  };

  const areMixinsConvertible = (mixinIdentifierNames, classPath) => {
    if (
      ReactUtils.directlyHasMixinsField(classPath) &&
      !ReactUtils.directlyHasSpecificMixins(classPath, mixinIdentifierNames)
    ) {
      return false;
    }
    return true;
  };

  // ---------------------------------------------------------------------------
  // Collectors
  const pickReturnValueOrCreateIIFE = value => {
    if (hasSingleReturnStatement(value)) {
      if (value.body.type === 'ObjectExpression') {
        return value.body;
      } else {
        return value.body.body[0].argument;
      }
    } else {
      return j.callExpression(
        value,
        []
      );
    }
  };

  const createDefaultProps = prop =>
    withComments(
      j.property(
        'init',
        j.identifier(DEFAULT_PROPS_KEY),
        pickReturnValueOrCreateIIFE(prop.value)
      ),
      prop
    );

  // Collects `childContextTypes`, `contextTypes`, `displayName`, and `propTypes`;
  // simplifies `getDefaultProps` or converts it to an IIFE;
  // and collects everything else in the `statics` property object.
  const collectStatics = specPath => {
    const result = [];

    for (let i = 0; i < specPath.properties.length; i++) {
      const property = specPath.properties[i];
      if (createFindPropFn('statics')(property) && property.value && property.value.properties) {
        result.push(...property.value.properties);
      } else if (createFindPropFn(DEFAULT_PROPS_FIELD)(property)) {
        result.push(createDefaultProps(property));
      } else if (property.key && STATIC_KEYS.hasOwnProperty(property.key.name)) {
        result.push(property);
      }
    }

    return result;
  };

  const collectNonStaticProperties = specPath => specPath.properties
    .filter(prop =>
      !(filterDefaultPropsField(prop) || filterGetInitialStateField(prop))
    )
    .filter(prop => (!STATIC_KEYS.hasOwnProperty(prop.key.name)) && prop.key.name !== STATIC_KEY)
    .filter(prop =>
      isFunctionExpression(prop) ||
      isPrimPropertyWithTypeAnnotation(prop) ||
      isPrimProperty(prop)
    );

  const findRequirePathAndBinding = (moduleName) => {
    let result = null;
    const requireCall = root.find(j.VariableDeclarator, {
      id: {type: 'Identifier'},
      init: {
        callee: {name: 'require'},
        arguments: [{value: moduleName}],
      },
    });

    const importStatement = root.find(j.ImportDeclaration, {
      source: {
        value: moduleName,
      },
    });

    if (importStatement.size()) {
      importStatement.forEach(path => {
        result = {
          path,
          binding: path.value.specifiers[0].local.name,
          type: 'import',
        };
      });
    } else if (requireCall.size()) {
      requireCall.forEach(path => {
        result = {
          path,
          binding: path.value.id.name,
          type: 'require',
        };
      });
    }

    return result;
  };

  const pureRenderMixinPathAndBinding = findRequirePathAndBinding(PURE_MIXIN_MODULE_NAME);

  // ---------------------------------------------------------------------------
  // Boom!
  const prefixCreateClass = path => {
    path.find(j.CallExpression, {
      callee: {
        name: 'createClass',
      },
    })
    .replaceWith((path) => {
      let args = path.value.arguments;
      return j.memberExpression(
        j.identifier('React'),
        j.callExpression(
          j.identifier('createClass'),
          args
        ),
      );
    });
    // I am not sure why we need this but without it the rest of the code
    // can't find React.createClass
    root = j(root.toSource());
  };

  const changeRequireProps = (path, modulePath, oldName, newName) => {
    path.findVariableDeclarators()
        .filter(j.filters.VariableDeclarator.requiresModule(modulePath))
        .forEach((node) => {
          let props = node.value.id.properties;

          if (!props) {
            // Must be a direct import e.g.
            // `const React = require(...)`
            return;
          }

          props.forEach((prop) => {
            if (prop.key.name === oldName) {
              prop.key.name = newName;
            }
          });
        });
  };

  /**
   * The pattern `module.exports = React.createClass() { ... }` breaks things when it comes
   * to adding static properties to the class. This method changes this pattern to
   * ```
   * const <displayName> = React.createClass() {
   *   ...
   * }
   *
   * module.exports = <displayName>
   * ```
   */
  const fixModuleExport = path => {
    return path.find(j.ExpressionStatement, {
      expression: {
        left: {
          object: {
            name: "module"
          },
          property: {
            name: "exports"
          }
        },
        right: {
            callee: {
              object: {
                name: "React"
              },
              property: {
                name: "createClass"
              }
            }
        }
      }
    })
    .replaceWith(({ node }) => {
      let displayName = getComponentNameFromArgs(node.expression.right.arguments);

      if (displayName) {
        return j.variableDeclaration("const", [
          j.variableDeclarator(j.identifier(displayName), node.expression.right)
        ]);
      }
    })
    .forEach(node => {
      let displayName = getComponentNameFromArgs(node.value.declarations[0].init.arguments);

      node.insertAfter(
        j.expressionStatement(
          j.assignmentExpression(
            "=",
            j.memberExpression(
              j.identifier("module"),
              j.identifier("exports"),
              false
            ),
            j.identifier(displayName)
          )
        )
      );
    })
  };

  let usePureComponent = false;
  const prepForPureComponent = path => {
    return path
      .find(j.CallExpression, {
        callee: {
          object: {
            name: "React"
          },
          property: {
            name: "createClass"
          }
        }
      })
      .forEach(path => {
        let node = path.node;
        let props = node.arguments[0].properties;
        let mixinProp = null;
        let idx = 0;

        for (let i = 0; i < props.length; i++) {
          let p = props[i];
          if (p.key.name === "mixins") {
            idx = i;
            mixinProp = p;
          }
        }

        if (!mixinProp) {
          return;
        }

        let mixins = mixinProp.value.elements;

        if (mixins.length === 1 && mixins[0].property.name === "PureRenderMixin") {
          let mixin = mixins[0];
          let varName = mixin.object.name || mixin.object.property.name;

          // Remove mixin property
          props.splice(idx, 1);

          // Now we know we need to use PureComponent
          usePureComponent = true;

          let componentScope = j(path.parentPath.parentPath.parentPath.parentPath);

          let occurances = componentScope.find(j.Identifier, { name: varName });

          // The addons module name can only be used twice:
          // Once in the require and once in the mixin array.
          // If it is used more than this we remove it.
          if (occurances.paths().length === 2) {
            componentScope
              .findVariableDeclarators()
              .filter(
                j.filters.VariableDeclarator.requiresModule("devtools/client/shared/vendor/react")
              )
              .forEach(node => {
                let props = node.value.id.properties;

                if (!props) {
                  return;
                }

                for (let i = 0; i < props.length; i++) {
                  let prop = props[i];
                  if (prop.key.name === varName) {
                    props.splice(i, 1);
                    break;
                  }
                }
              });
          }
        }
      });
  };

  const createMethodDefinition = fn =>
    withComments(j.methodDefinition(
      'method',
      fn.key,
      fn.value
    ), fn);

  const updatePropsAndContextAccess = getInitialState => {
    const collection = j(getInitialState);

    collection.find(j.MemberExpression, {
      object: {
        type: 'ThisExpression',
      },
      property: {
        type: 'Identifier',
        name: 'props',
      },
    }).forEach(path => j(path).replaceWith(j.identifier('props')));

    collection.find(j.MemberExpression, {
      object: {
        type: 'ThisExpression',
      },
      property: {
        type: 'Identifier',
        name: 'context',
      },
    }).forEach(path => j(path).replaceWith(j.identifier('context')));
  };

  const inlineGetInitialState = getInitialState => {
    const functionExpressionCollection = j(getInitialState.value);

    // at this point if there exists bindings like `const props = ...`, we
    // already know the RHS must be `this.props` (see `isGetInitialStateConstructorSafe`)
    // so it's safe to just remove them
    functionExpressionCollection.find(j.VariableDeclarator, {id: {name: 'props'}})
      .forEach(path => j(path).remove());

    functionExpressionCollection.find(j.VariableDeclarator, {id: {name: 'context'}})
      .forEach(path => j(path).remove());

    return functionExpressionCollection
      .find(j.ReturnStatement)
      .filter(path => {
        // filter out inner function declarations here (helper functions, promises, etc.).
        const mainBodyCollection = j(getInitialState.value.body);
        return (
          mainBodyCollection
            .find(j.ArrowFunctionExpression)
            .find(j.ReturnStatement, path.value)
            .size() === 0 &&
          mainBodyCollection
            .find(j.FunctionDeclaration)
            .find(j.ReturnStatement, path.value)
            .size() === 0 &&
          mainBodyCollection
            .find(j.FunctionExpression)
            .find(j.ReturnStatement, path.value)
            .size() === 0
        );
      })
      .forEach(path => {
        let shouldInsertReturnAfterAssignment = false;

        // if the return statement is not a direct child of getInitialState's body
        if (getInitialState.value.body.body.indexOf(path.value) === -1) {
          shouldInsertReturnAfterAssignment = true;
        }

        j(path).replaceWith(j.expressionStatement(
          j.assignmentExpression(
            '=',
            j.memberExpression(
              j.thisExpression(),
              j.identifier('state'),
              false
            ),
            path.value.argument
          )
        ));

        if (shouldInsertReturnAfterAssignment) {
          j(path).insertAfter(j.returnStatement(null));
        }
      }).getAST()[0].value.body.body;
  };

  const createConstructorArgs = (hasContextAccess) => {
    if (hasContextAccess) {
      return [j.identifier('props'), j.identifier('context')];
    }

    return [j.identifier('props')];
  };

  const createConstructor = (rawProperties, methodsToBind, getInitialState) => {
    let hasContextAccess = false;
    let statements = [];

    if (getInitialState) {
      const initialStateAST = j(getInitialState);
      if (
        initialStateAST.find(j.MemberExpression, { // has `this.context` access
          object: {type: 'ThisExpression'},
          property: {type: 'Identifier', name: 'context'},
        }).size() ||
        initialStateAST.find(j.CallExpression, { // a direct method call `this.x()`
          callee: {
            type: 'MemberExpression',
            object: {type: 'ThisExpression'},
          },
        }).size() ||
        initialStateAST.find(j.MemberExpression, { // `this` is referenced alone
          object: {type: 'ThisExpression'},
        }).size() !== initialStateAST.find(j.ThisExpression).size()
      ) {
        hasContextAccess = true;
      }
      updatePropsAndContextAccess(getInitialState);
    }

    const constructorArgs = createConstructorArgs(hasContextAccess);

    if (getInitialState) {
      statements = statements.concat(
        inlineGetInitialState(getInitialState)
      );
    }

    if (rawProperties.length > 0) {
      rawProperties.filter(p => isPrimProperty(p)).forEach(p => {
        statements.push(
          j.expressionStatement(
            j.assignmentExpression(
              '=',
              j.memberExpression(
                j.thisExpression(),
                j.identifier(p.key.name),
                false
              ),
              p.value
            )
          )
        );
      });
    }


    if (methodsToBind.length > 0) {
      methodsToBind.forEach(m => {
        statements.push(
          j.expressionStatement(
            j.assignmentExpression(
              '=',
              j.memberExpression(
                j.thisExpression(),
                j.identifier(m),
                false
              ),

              j.memberExpression(
                j.memberExpression(
                  j.thisExpression(),
                  j.identifier(m),
                  false
                ),
                j.callExpression(
                  j.identifier('bind'),
                  [
                    j.thisExpression()
                  ]
                ),
                false
              ),
            )
          )
        );
      });
    }

    if (statements.length > 0) {
      return [
        createMethodDefinition({
          key: j.identifier('constructor'),
          value: j.functionExpression(
            null,
            constructorArgs,
            j.blockStatement(
              [
                j.expressionStatement(
                  j.callExpression(
                    j.identifier('super'),
                    constructorArgs
                  )
                ),
                ...statements
              ],
            )
          ),
        }),
      ];
    } else {
      return [];
    }
  };

  const createClassPropertyWithType = prop =>
    withComments(j.classProperty(
      j.identifier(prop.key.name),
      prop.value.expression,
      prop.value.typeAnnotation,
      false
    ), prop);

  // ---------------------------------------------------------------------------
  // Flow!

  const flowAnyType = j.anyTypeAnnotation();
  const flowFixMeType = j.genericTypeAnnotation(
    j.identifier('$FlowFixMe'),
    null
  );

  const literalToFlowType = node => {
    if (node.type === 'Identifier' && node.name === 'undefined') {
      return j.voidTypeAnnotation();
    }

    switch (typeof node.value) {
      case 'string':
        return j.stringLiteralTypeAnnotation(node.value, node.raw);
      case 'number':
        return j.numberLiteralTypeAnnotation(node.value, node.raw);
      case 'boolean':
        return j.booleanLiteralTypeAnnotation(node.value, node.raw);
      case 'object': // we already know it's a NullLiteral here
        return j.nullLiteralTypeAnnotation();
      default: // this should never happen
        return flowFixMeType;
    }
  };

  const propTypeToFlowMapping = {
    // prim types
    any: flowAnyType,
    array: j.genericTypeAnnotation(
      j.identifier('Array'),
      j.typeParameterInstantiation([flowFixMeType])
    ),
    bool: j.booleanTypeAnnotation(),
    element: flowFixMeType, // flow does the same for `element` type in `propTypes`
    func: j.genericTypeAnnotation(
      j.identifier('Function'),
      null
    ),
    node: flowFixMeType, // flow does the same for `node` type in `propTypes`
    number: j.numberTypeAnnotation(),
    object: j.genericTypeAnnotation(
      j.identifier('Object'),
      null
    ),
    string: j.stringTypeAnnotation(),

    // type classes
    arrayOf: (type) => j.genericTypeAnnotation(
      j.identifier('Array'),
      j.typeParameterInstantiation([type])
    ),
    instanceOf: (type) => j.genericTypeAnnotation(
      type,
      null
    ),
    objectOf: (type) => j.objectTypeAnnotation([], [
      j.objectTypeIndexer(
        j.identifier('key'),
        j.stringTypeAnnotation(),
        type
      )
    ]),
    oneOf: (typeList) => j.unionTypeAnnotation(typeList),
    oneOfType: (typeList) => j.unionTypeAnnotation(typeList),
    shape: (propList) => j.objectTypeAnnotation(propList),
  };

  const propTypeToFlowAnnotation = val => {
    let cursor = val;
    let isOptional = true;
    let typeResult = flowFixMeType;

    if ( // check `.isRequired` first
      cursor.type === 'MemberExpression' &&
      cursor.property.type === 'Identifier' &&
      cursor.property.name === 'isRequired'
    ) {
      isOptional = false;
      cursor = cursor.object;
    }

    switch (cursor.type) {
      case 'CallExpression': { // type class
        const calleeName = cursor.callee.type === 'MemberExpression' ?
          cursor.callee.property.name :
          cursor.callee.name;

        const constructor = propTypeToFlowMapping[calleeName];
        if (!constructor) { // unknown type class
          // it's not necessary since `typeResult` defaults to `flowFixMeType`,
          // but it's more explicit this way
          typeResult = flowFixMeType;
          break;
        }

        switch (cursor.callee.property.name) {
          case 'arrayOf': {
            const arg = cursor.arguments[0];
            typeResult = constructor(
              propTypeToFlowAnnotation(arg)[0]
            );
            break;
          }
          case 'instanceOf': {
            const arg = cursor.arguments[0];
            if (arg.type !== 'Identifier') {
              typeResult = flowFixMeType;
              break;
            }

            typeResult = constructor(arg);
            break;
          }
          case 'objectOf': {
            const arg = cursor.arguments[0];
            typeResult = constructor(
              propTypeToFlowAnnotation(arg)[0]
            );
            break;
          }
          case 'oneOf': {
            const argList = cursor.arguments[0].elements;
            if (
              !argList ||
              !argList.every(node =>
                (node.type === 'Literal') ||
                (node.type === 'Identifier' && node.name === 'undefined')
              )
            ) {
              typeResult = flowFixMeType;
            } else {
              typeResult = constructor(
                argList.map(literalToFlowType)
              );
            }
            break;
          }
          case 'oneOfType': {
            const argList = cursor.arguments[0].elements;
            if (!argList) {
              typeResult = flowFixMeType;
            } else {
              typeResult = constructor(
                argList.map(arg => propTypeToFlowAnnotation(arg)[0])
              );
            }
            break;
          }
          case 'shape': {
            const rawPropList = cursor.arguments[0].properties;
            if (!rawPropList) {
              typeResult = flowFixMeType;
              break;
            }
            const flowPropList = [];
            rawPropList.forEach(typeProp => {
              const keyIsLiteral = typeProp.key.type === 'Literal';
              const name = keyIsLiteral ? typeProp.key.value : typeProp.key.name;

              const [valueType, isOptional] = propTypeToFlowAnnotation(typeProp.value);
              flowPropList.push(j.objectTypeProperty(
                keyIsLiteral ? j.literal(name) : j.identifier(name),
                valueType,
                isOptional
              ));
            });

            typeResult = constructor(flowPropList);
            break;
          }
          default: {
            break;
          }
        }
        break;
      }
      case 'MemberExpression': { // prim type
        if (cursor.property.type !== 'Identifier') { // unrecognizable
          typeResult = flowFixMeType;
          break;
        }

        const maybeType = propTypeToFlowMapping[cursor.property.name];
        if (maybeType) {
          typeResult = propTypeToFlowMapping[cursor.property.name];
        } else { // type not found
          typeResult = flowFixMeType;
        }

        break;
      }
      default: { // unrecognizable
        break;
      }
    }

    return [typeResult, isOptional];
  };

  const createFlowAnnotationsFromPropTypesProperties = (prop) => {
    const typePropertyList = [];

    if (!prop || prop.value.type !== 'ObjectExpression') {
      return typePropertyList;
    }

    prop.value.properties.forEach(typeProp => {
      if (!typeProp.key) { // stuff like SpreadProperty
        return;
      }

      const keyIsLiteral = typeProp.key.type === 'Literal';
      const name = keyIsLiteral ? typeProp.key.value : typeProp.key.name;

      const [valueType, isOptional] = propTypeToFlowAnnotation(typeProp.value);
      typePropertyList.push(j.objectTypeProperty(
        keyIsLiteral ? j.literal(name) : j.identifier(name),
        valueType,
        isOptional
      ));
    });

    return j.classProperty(
      j.identifier('props'),
      null,
      j.typeAnnotation(j.objectTypeAnnotation(typePropertyList)),
      false
    );
  };

  // to ensure that our property initializers' evaluation order is safe
  const repositionStateProperty = (initialStateProperty, propertiesAndMethods) => {
    const initialStateCollection = j(initialStateProperty);
    const thisCount = initialStateCollection.find(j.ThisExpression).size();
    const safeThisMemberCount = initialStateCollection.find(j.MemberExpression, {
      object: {
        type: 'ThisExpression',
      },
      property: {
        type: 'Identifier',
        name: 'props',
      },
    }).size() + initialStateCollection.find(j.MemberExpression, {
      object: {
        type: 'ThisExpression',
      },
      property: {
        type: 'Identifier',
        name: 'context',
      },
    }).size();

    if (thisCount === safeThisMemberCount) {
      return initialStateProperty.concat(propertiesAndMethods);
    }

    const result = [].concat(propertiesAndMethods);
    let lastPropPosition = result.length - 1;

    while (lastPropPosition >= 0 && result[lastPropPosition].kind === 'method') {
      lastPropPosition--;
    }

    result.splice(lastPropPosition + 1, 0, initialStateProperty[0]);
    return result;
  };

  // if there's no `getInitialState` or the `getInitialState` function is simple
  // (i.e., it's just a return statement) then we don't need a constructor.
  // we can simply lift `state = {...}` as a property initializer.
  // otherwise, create a constructor and inline `this.state = ...`.
  //
  // when we need to create a constructor, we only put `context` as the
  // second parameter when the following things happen in `getInitialState()`:
  // 1. there's a `this.context` access, or
  // 2. there's a direct method call `this.x()`, or
  // 3. `this` is referenced alone
  const createESClass = (
    name,
    baseClassName,
    staticProperties,
    getInitialState,
    rawProperties,
    comments
  ) => {
    const initialStateProperty = [];
    let maybeConstructor = [];
    let maybeFlowStateAnnotation = []; // we only need this when we do `this.state = ...`

    const methodsToBind = rawProperties.map(prop => {
      if (AUTOBIND_IGNORE_KEYS.hasOwnProperty(prop.key.name)) {
        return false;
      }

      if (isFunctionExpression(prop)) {
        return prop.key.name;
      }
    }).filter(x => x);

    maybeConstructor = createConstructor(rawProperties, methodsToBind, getInitialState);
    if (shouldTransformFlow) {
      let stateType = j.typeAnnotation(
        j.existsTypeAnnotation()
      );

      if (getInitialState.value.returnType) {
        stateType = getInitialState.value.returnType;
      }

      maybeFlowStateAnnotation.push(j.classProperty(
        j.identifier('state'),
        null,
        stateType,
        false
      ));
    }

    const propertiesAndMethods = rawProperties.map(prop => {
      if (isPrimPropertyWithTypeAnnotation(prop)) {
        return createClassPropertyWithType(prop);
      } else if (isPrimProperty(prop)) {
        return false;
      } else if (AUTOBIND_IGNORE_KEYS.hasOwnProperty(prop.key.name)) {
        return createMethodDefinition(prop);
      }

      return createMethodDefinition(prop);
    }).filter(x => x);

    const flowPropsAnnotation = shouldTransformFlow ?
      createFlowAnnotationsFromPropTypesProperties(
        staticProperties.find((path) => path.key.name === 'propTypes')
      ) :
      [];

    if (shouldTransformFlow && options['remove-runtime-proptypes']) {
      finalStaticProperties = staticProperties.filter((prop) => prop.key.name !== 'propTypes');
    }

    staticProperties = staticProperties.filter(x => x).map(p => {
      return withComments(
        j.methodDefinition(
          "get",
          j.identifier(p.key.name),
          j.functionExpression(
            null,
            [],
            j.blockStatement([
              j.returnStatement(p.value)
            ])
          ),
          true
        ),
        p
      );
    });

    let finalStaticProperties = staticProperties;

    return withComments(j.classDeclaration(
      name ? j.identifier(name) : null,
      j.classBody(
        [].concat(
          finalStaticProperties,
          flowPropsAnnotation,
          maybeFlowStateAnnotation,
          maybeConstructor,
          repositionStateProperty(initialStateProperty, propertiesAndMethods)
        )
      ),
      j.identifier(baseClassName)
    ), {comments});
  };

  const getComments = classPath => {
    if (classPath.value.comments) {
      return classPath.value.comments;
    }
    const declaration = j(classPath).closest(j.VariableDeclaration);
    if (declaration.size()) {
      return declaration.get().value.comments;
    }
    return null;
  };

  const findUnusedVariables = (path, varName) => j(path)
    .closestScope()
    .find(j.Identifier, {name: varName})
    // Ignore require vars
    .filter(identifierPath => identifierPath.value !== path.value.id)
    // Ignore import bindings
    .filter(identifierPath => !(
      path.value.type === 'ImportDeclaration' &&
      path.value.specifiers.some(specifier => specifier.local === identifierPath.value)
    ))
    // Ignore properties in MemberExpressions
    .filter(identifierPath => {
      const parent = identifierPath.parent.value;
      return !(
        j.MemberExpression.check(parent) &&
        parent.property === identifierPath.value
      );
    });

  const updateToClass = (classPath) => {
    const specPath = ReactUtils.directlyGetCreateClassSpec(classPath);
    const name = ReactUtils.directlyGetComponentName(classPath);
    const statics = collectStatics(specPath);
    const properties = collectNonStaticProperties(specPath);
    const comments = getComments(classPath);

    const getInitialState = findGetInitialState(specPath);

    var path = classPath;

    if (
      classPath.parentPath &&
      classPath.parentPath.value &&
      classPath.parentPath.value.type === 'VariableDeclarator'
    ) {
      // the reason that we need to do this awkward dance here is that
      // for things like `var Foo = React.createClass({...})`, we need to
      // replace the _entire_ VariableDeclaration with
      // `class Foo extends React.Component {...}`.
      // it looks scary but since we already know it's a VariableDeclarator
      // it's actually safe.
      // (VariableDeclaration > declarations > VariableDeclarator > CallExpression)
      path = classPath.parentPath.parentPath.parentPath;
    }

    const baseClassName =
      usePureComponent ||
      (pureRenderMixinPathAndBinding &&
      ReactUtils.directlyHasSpecificMixins(classPath, [pureRenderMixinPathAndBinding.binding])) ?
        'PureComponent' :
        'Component';

    j(path).replaceWith([
      createESClass(
        name,
        baseClassName,
        STATIC_GETTERS ? statics : [],
        getInitialState,
        properties,
        comments
      ),
    ]);

    if (!STATIC_GETTERS) {
      statics.reverse().filter(x => x).map(p => {
        let x = path;

        if (x.parentPath && x.parentPath.value.type == 'ExportNamedDeclaration') {
          x = x.parentPath;
        }

        j(x).insertAfter(
          withComments(
            j.expressionStatement(
              j.assignmentExpression(
                '=',
                j.memberExpression(
                  j.identifier(name),
                  j.identifier(p.key.name),
                  false
                ),
                p.value,
              )
            ),
            p
          )
        );
      });
    }
  };

  const addDisplayName = (displayName, specPath) => {
    const props = specPath.properties;
    let safe = true;

    for (let i = 0; i < props.length; i++) {
      const prop = props[i];
      if (prop.key.name === 'displayName') {
        safe = false;
        break;
      }
    }

    if (safe) {
      props.unshift(j.objectProperty(j.identifier('displayName'), j.stringLiteral(displayName)));
    }
  };

  const fallbackToCreateClassModule = (classPath) => {
    const comments = getComments(classPath);
    const specPath = ReactUtils.directlyGetCreateClassSpec(classPath);

    if (!NO_DISPLAY_NAME) {
      if (specPath) {
        // Add a displayName property to the spec object
        let path = classPath;
        let displayName;
        while (path && displayName === undefined) {
          switch (path.node.type) {
            case 'ExportDefaultDeclaration':
              displayName = basename(file.path, extname(file.path));
              if (displayName === 'index') {
                // ./{module name}/index.js
                displayName = basename(dirname(file.path));
              }
              break;
            case 'VariableDeclarator':
              displayName = path.node.id.name;
              break;
            case 'AssignmentExpression':
              displayName = path.node.left.name;
              break;
            case 'Property':
              displayName = path.node.key.name;
              break;
            case 'Statement':
              displayName = null;
              break;
          }
          path = path.parent;
        }
        if (displayName) {
          addDisplayName(displayName, specPath);
        }
      }
    }

    withComments(
      j(classPath).replaceWith(
        specPath
         ? j.callExpression(j.identifier(CREATE_CLASS_VARIABLE_NAME), [specPath])
         : j.callExpression(j.identifier(CREATE_CLASS_VARIABLE_NAME), classPath.value.arguments)
      ),
      {comments}
    );
  };

  if (
    options['explicit-require'] === false || ReactUtils.hasReact(root)
  ) {
    // We greatly simplify life for ourselves by changing createClass to
    // React.createClass. Without this small change we need to change
    // countless too many lines of code.
    prefixCreateClass(root);

    fixModuleExport(root);

    prepForPureComponent(root);

    changeRequireProps(root,
      'devtools/client/shared/vendor/react',
      'createClass',
      usePureComponent ? 'PureComponent' : 'Component'
);

    // no mixins found on the classPath -> true
    // pure mixin identifier not found -> (has mixins) -> false
    // found pure mixin identifier ->
    //   class mixins is an array and only contains the identifier -> true
    //   otherwise -> false
    const mixinsFilter = (classPath) => {
      if (!ReactUtils.directlyHasMixinsField(classPath)) {
        return true;
      } else if (options['pure-component'] && pureRenderMixinPathAndBinding) {
        const {binding} = pureRenderMixinPathAndBinding;
        if (areMixinsConvertible([binding], classPath)) {
          return true;
        }
      }
      console.warn(
        file.path + ': `' + ReactUtils.directlyGetComponentName(classPath) + '` ' +
        'was skipped because of inconvertible mixins.'
      );

      return false;
    };

    const reinsertTopComments = () => {
      root.get().node.comments = topComments;
    };

    let didTransform = false;
    let didFallback = false;

    const path = ReactUtils.findAllReactCreateClassCalls(root);
    if (NO_CONVERSION) {
      path.forEach(childPath => {
        fallbackToCreateClassModule(childPath);
      });
      didFallback = true;
    } else {
      // the only time that we can't simply replace the createClass call path
      // with a new class is when the parent of that is a variable declaration.
      // let's delay it and figure it out later (by looking at `path.parentPath`)
      // in `updateToClass`.
      path.forEach(childPath => {
        if (
          mixinsFilter(childPath) &&
          hasNoCallsToDeprecatedAPIs(childPath) &&
          hasNoRefsToAPIsThatWillBeRemoved(childPath) &&
          doesNotUseArguments(childPath) &&
          isInitialStateConvertible(childPath) &&
          canConvertToClass(childPath)
        ) {
          didTransform = true;
          updateToClass(childPath);
        } else {
          didFallback = true;
          fallbackToCreateClassModule(childPath);
        }
      });
    }

    if (didFallback) {
      const reactPathAndBinding =
        findRequirePathAndBinding('react') ||
        findRequirePathAndBinding('React');

      if (reactPathAndBinding) {
        const {path, type} = reactPathAndBinding;
        let removePath = null;
        let shouldReinsertComment = false;
        if (type === 'require') {
          const kind = path.parent.value.kind;
          j(path.parent).insertAfter(j.template.statement([
            `${kind} ${CREATE_CLASS_VARIABLE_NAME} = require('${CREATE_CLASS_MODULE_NAME}');`
          ]));
          const bodyNode = path.parentPath.parentPath.parentPath.value;
          const variableDeclarationNode = path.parentPath.parentPath.value;
          shouldReinsertComment = bodyNode.indexOf(variableDeclarationNode) === 0;
          removePath = path.parent;
        } else {
          j(path).insertAfter(j.template.statement([
            `import ${CREATE_CLASS_VARIABLE_NAME} from '${CREATE_CLASS_MODULE_NAME}';`
          ]));
          const importDeclarationNode = path.value;
          const bodyNode = path.parentPath.value;
          removePath = path;
          const specifiers = path.value.specifiers;
          if (specifiers.length === 1) {
            shouldReinsertComment = bodyNode.indexOf(importDeclarationNode) === 0;
            removePath = path;
          } else {
            const paths = j(path).find(j.ImportDefaultSpecifier);
            if (paths.length) {
              removePath = j(path).find(j.ImportDefaultSpecifier).paths()[0];
            }
          }
        }

        const shouldRemoveReactImport = (
          removePath &&
          root.find(j.Identifier).filter(path => path.value.name === 'React').length === 1 &&
          root.find(j.JSXElement).length === 0
        );
        if (shouldRemoveReactImport && removePath) {
          j(removePath).remove();
          if (shouldReinsertComment) {
            reinsertTopComments();
          }
        }
      }
    }

    if (didTransform) {
      // prune removed requires
      if (pureRenderMixinPathAndBinding) {
        const {binding, path, type} = pureRenderMixinPathAndBinding;
        let shouldReinsertComment = false;
        if (findUnusedVariables(path, binding).size() === 0) {
          var removePath = null;
          if (type === 'require') {
            const bodyNode = path.parentPath.parentPath.parentPath.value;
            const variableDeclarationNode = path.parentPath.parentPath.value;

            if (variableDeclarationNode.declarations.length === 1) {
              removePath = path.parentPath.parentPath;
              shouldReinsertComment = bodyNode.indexOf(variableDeclarationNode) === 0;
            } else {
              removePath = path;
            }
          } else {
            const importDeclarationNode = path.value;
            const bodyNode = path.parentPath.value;

            removePath = path;
            shouldReinsertComment = bodyNode.indexOf(importDeclarationNode) === 0;
          }

          j(removePath).remove();
          if (shouldReinsertComment) {
            reinsertTopComments();
          }
        }
      }
    }
  }
  return root.toSource(printOptions);
};

module.exports.parser = 'flow';
