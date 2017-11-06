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

module.exports = (file, api, options) => {
  const j = api.jscodeshift;
  const root = j(file.source);

  const ReactUtils = require('./utils/ReactUtils')(j);
  const { describe } = require('jscodeshift-helper');

  const REACT_PATH = "devtools/client/shared/vendor/react";
  const DOMFACTORY_PATH = "devtools/client/shared/vendor/react-dom-factories";

  const printOptions = options.printOptions || {
    arrayBracketSpacing: true,
    arrowParensAlways: false,
    flowObjectCommas: true,
    lineTerminator: '\n',
    objectCurlySpacing: true,
    quote: "double",
    range: false,
    tabWidth: 4,
    trailingComma: true,
    useTabs: false,
    wrapColumn: 90,
  };

  function removeDOMFactoryRequire(name) {
    root
      .findVariableDeclarators()
      .filter(path => {
        let props = path.value.id.properties;
        if (props) {
          return (
            props.filter(prop => {
              return prop.key.name === name;
            }).length > 0
          );
        } else if (path.value.id.name === name) {
          return true;
        }
        return false;
      })
      .forEach(path => {
        let props = path.value.id.properties;

        if (props) {
          for (let i = 0; i < props.length; i++) {
            let prop = props[i];
            if (prop.key.name === name) {
              if (props.length > 1) {
                props = props.splice(i, 1);
              } else {
                path.prune();
              }
              break;
            }
          }
        } else if (path.value.id.name == name) {
          path.prune();
        }
      });
  }

  function findRequire(requirePath) {
    let req = root.find(j.VariableDeclaration, {
      declarations: [
        {
          init: {
            callee: {
              name: "require"
            },
            arguments: [
              {
                value: requirePath
              }
            ]
          }
        }
      ]
    });

    if (req.size() > 0) {
      return req.at(0);
    }

    return null;
  }

  function insertRequireAfter(req, identifier, reqPath) {
    req.insertAfter(
      j.variableDeclaration("const", [
        j.variableDeclarator(
          j.identifier(identifier),
          j.callExpression(j.identifier("require"), [j.literal(reqPath)])
        )
      ])
    );
  }

  function replaceReactDotDom() {
    root.findVariableDeclarators().filter(path => {
      let init = path.value.init;
      if (init && init.type === "MemberExpression") {
        let { object, property } = init;
        if (object && property && (object.name === "React" && property.name === "DOM") ) {
          path.value.init = j.identifier("dom");
        }
      }
    });
  }

  let req = findRequire(REACT_PATH);

  if (!req) {
    return;
  }

  removeDOMFactoryRequire("DOM");
  removeDOMFactoryRequire("dom");

  // There is a small possibility that the require path has been erased so we
  // need to get it again.
  req = findRequire(REACT_PATH);

  if (!req) {
    return;
  }

  insertRequireAfter(req, "dom", DOMFACTORY_PATH);

  replaceReactDotDom();

  return root.toSource(printOptions);
}
