## moz-codemod

This repository contains a collection of codemod scripts for use with
[JSCodeshift](https://github.com/facebook/jscodeshift) that help update JavaScript files.

It is a fork of reactjs/react-codemod but with transforms specifically designed to work with Mozilla's style of coding.

### Setup & Run

1. `yarn global add jscodeshift`
1. `git clone https://github.com/MikeRatcliffe/moz-codemod.git` or download a zip file from `https://github.com/MikeRatcliffe/moz-codemod/archive/master.zip`
1. Run `yarn install` in the moz-codemod directory
1. `jscodeshift -t <codemod-script> <path>`
   * use the `-d` option for a dry-run and use `-p` to print the output for comparison;
   * if you use flowtype, you might also need to use `--parser=flow`.

### Included Scripts

#### `mozclass`

Converts React's createClass() "classes" into fully fledged ES6 classes.

A version of the "new ES2015 class transform with property initializers" that you can see below. This version has been specifically adapted to run on Mozilla's codebase... the output runs in browser without any transpiling.

Key differences between the two versions:

- class.js turns all custom methods into ES6 class arrow functions:

  ```js
  someClassMethod = () => {
    ...
  }
  ```

  mozclass bind them in the constructor instead:

  ```js
  someClassMethod = someClassMethod.bind(this)
  ```

- class.js adds a bunch of static properties to the class:

  ```js
  static displayName = "MyComponent"
  ```

  mozclass can add them inside the class body as static getters (default):

  ```
  static get displayName() {
    return "MyComponent"
  }
  ```
  Or after the class body (--no-static-getters):

  ```js
  MyComponent.displayName = "MyComponent"
  ```

##### Usage

All you normally need is:

```bash
jscodeshift -t ./transforms/mozclass.js <path>
```

But feel free to include options see "ES2015 class transform with property initializers" for an explaination:

```bash
jscodeshift -t ./transforms/mozclass.js --mixin-module-name=react-addons-pure-render-mixin --flow=true --pure-component=true --no-static-getters --add-displayname=true --remove-runtime-proptypes=false <path>
```

#### `mozproptypes`

Switches from old PropTypes module to the external PropTypes module:

```
// Old Module
const { PropTypes } = require("devtools/client/shared/vendor/react");

// New module
const PropTypes = require("devtools/client/shared/vendor/react-prop-types");
```

#### Explanation of the new ES2015 class transform with property initializers
1. Determine if mixins are convertible. We only transform a `createClass` call to an ES6 class component when:
  - There are no mixins on the class, or
  - `options['pure-component']` is true, the `mixins` property is an array and it _only_ contains pure render mixin (the specific module name can be specified using `options['mixin-module-name']`, which defaults to `react-addons-pure-render-mixin`)
2. Ignore components that:
  - Call deprecated APIs. This is very defensive, if the script finds any identifiers called `isMounted`, `getDOMNode`, `replaceProps`, `replaceState` or `setProps` it will skip the component
  - Explicitly call `this.getInitialState()` and/or `this.getDefaultProps()` since an ES6 class component will no longer have these methods
  - Use `arguments` in methods since arrow functions don't have `arguments`. Also please notice that `arguments` should be [very carefully used](https://github.com/petkaantonov/bluebird/wiki/Optimization-killers#3-managing-arguments) and it's generally better to switch to spread (`...args`) instead
  - Have inconvertible `getInitialState()`. Specifically if you have variable declarations like `var props = ...` and the right hand side is not `this.props` then we can't inline the state initialization in the `constructor` due to variable shadowing issues
  - Have non-primitive right hand side values (like `foo: getStuff()`) in the class spec
3. Transform it to an ES6 class component
  1. Replace `var A = React.createClass(spec)` with `class A extends React.Component {spec}`. If a component uses pure render mixin and passes the mixins test (as described above), it will extend `React.PureComponent` instead
    - Remove the `require`/`import` statement that imports pure render mixin when it's no longer being referenced
  2. Pull out all statics defined on `statics` plus the few special cased statics like `childContextTypes`, `contextTypes`, `displayName`, `getDefaultProps()`, and `propTypes` and transform them to `static` properties (`static propTypes = {...};`)
    - If `getDefaultProps()` is simple (i.e. it only contains a return statement that returns something) it will be converted to a simple assignment (`static defaultProps = ...;`). Otherwise an IIFE (immediately-invoked function expression) will be created (`static defaultProps = function() { ... }();`). Note that this means that the function will be executed only a single time per app-lifetime. In practice this hasn't caused any issues — `getDefaultProps` should not contain any side-effects
  3. Transform `getInitialState()`
    - If there's no `getInitialState()` or the `getInitialState()` function is simple (i.e., it only contains a return statement that returns something) then we don't need a constructor; `state` will be lifted to a property initializer (`state = ...;`)
      - However, if the RHS of `return` contains references to `this` other than `this.props` and/or `this.context`, we can't be sure about what you'll need from `this`. We need to ensure that our property initializers' evaluation order is safe, so we defer `state`'s initialization by moving it all the way down until all other property initializers have been initialized
    - If `getInitialState()` is not simple, we create a `constructor` and convert `getInitialState()` to an assignment to `this.state`
      - `constructor` always have `props` as the first parameter
      - We only put `context` as the second parameter when (one of) the following things happen in `getInitialState()`:
        - It accesses `this.context`, or
        - There's a direct method call `this.x()`, or
        - `this` is referenced alone
      - Rewrite accesses to `this.props` to `props` and accesses to `this.context` to `context` since the values will be passed as `constructor` arguments
        - Remove _simple_ variable declarations like `var props = this.props;` and `var context = this.context`
      - Rewrite top-level return statements (`return {...};`) to `this.state = {...}`
        - Add `return;` after the assignment when the return statement is part of a control flow statement (not a direct child of `getInitialState()`'s body) and not in an inner function declaration
  4. Transform all non-lifecycle methods and fields to class property initializers (like `onClick = () => {};`). All your Flow annotations will be preserved
    - It's actually not necessary to transform all methods to arrow functions (i.e., to bind them), but this behavior is the same as `createClass()` and we can make sure that we won't accidentally break stuff
4. Generate Flow annotations from `propTypes` and put it on the class (this only happens when there's `/* @flow */` in your code and `options['flow']` is `true`)
  - Flow actually understands `propTypes` in `createClass` calls but not ES6 class components. Here the transformation logic is identical to [how](https://github.com/facebook/flow/blob/master/src/typing/statement.ml#L3526) Flow treats `propTypes`
  - Notice that Flow treats an optional propType as non-nullable
    - For example, `foo: React.PropTypes.number` is valid when you pass `{}`, `{foo: null}`, or `{foo: undefined}` as props at **runtime**. However, when Flow infers type from a `createClass` call, only `{}` and `{foo: undefined}` are valid; `{foo: null}` is not. Thus the equivalent type annotation in Flow is actually `{foo?: number}`. The question mark on the left hand side indicates `{}` and `{foo: undefined}` are fine, but when `foo` is present it must be a `number`
  - For `propTypes` fields that can't be recognized by Flow, `$FlowFixMe` will be used
5. `React.createClass` is no longer present in React 16. So, if a `createClass` call cannot be converted to a plain class, the script will fallback to using the `create-react-class` package.
  - Replaces `React.createClass` with `ReactCreateClass`.
  - Adds a `require` or `import` statement for `create-react-class`. The import style is inferred from the import style of the `react` import. The default module name can be overridden with the `--create-class-module-name` option.
  - Prunes the `react` import if there are no more references to it.

### Support and Contributing

The scripts in this repository are provided in the hope that they are useful,
but they are not officially maintained, and we generally will not fix
community-reported issues. They are a collection of scripts that were previously
used internally within Facebook or were contributed by the community, and we
rely on community contributions to fix any issues discovered or make any
improvements. If you want to contribute, you're welcome to submit a pull
request.
