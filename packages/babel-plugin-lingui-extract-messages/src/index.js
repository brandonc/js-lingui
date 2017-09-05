import fs from 'fs'
import fsPath from 'path'
import mkdirp from 'mkdirp'
import generate from 'babel-generator'
import getConfig from 'lingui-conf'

// Map of messages
const MESSAGES = Symbol('I18nMessages')

// We need to remember all processed nodes. When JSX expressions are
// replaced with CallExpressions, all children are traversed for each CallExpression.
// Then, i18n._ methods are visited multiple times for each parent CallExpression.
const VISITED = Symbol('I18nVisited')

function addMessage (path, messages, { id, ...attrs }) {
  if (messages.has(id)) {
    const message = messages.get(id)
    if (message.defaults !== attrs.defaults) {
      throw path.buildCodeFrameError('Different defaults for the same message ID.')
    } else {
      [].push.apply(message.origin, attrs.origin)
    }
  } else {
    messages.set(id, attrs)
  }
}

export default function ({ types: t }) {
  let localTransComponentName

  const opts = getConfig()
  const optsBaseDir = opts.rootDir

  function isTransComponent (node) {
    return t.isJSXElement(node) && t.isJSXIdentifier(node.openingElement.name, {
      name: localTransComponentName
    })
  }

  const isNoopMethod = node => t.isIdentifier(node, { name: 'i18nMark' })
  const isI18nMethod = node =>
    t.isMemberExpression(node) &&
    t.isIdentifier(node.object, { name: 'i18n' }) &&
    t.isIdentifier(node.property, { name: '_' })

  function collectMessage (path, file, props) {
    const messages = file.get(MESSAGES)

    const filename = fsPath.relative(optsBaseDir, file.opts.filename)
    const line = path.node.loc ? path.node.loc.start.line : null
    props.origin = [[filename, line]]

    addMessage(path, messages, props)
  }

  return {
    visitor: {
      // Get the local name of Trans component. Usually it's just `Trans`, but
      // it might be different when the import is aliased:
      // import { Trans as T } from 'lingui-react';
      ImportDeclaration (path) {
        const { node } = path

        if (!['lingui-react', 'lingui-i18n'].includes(node.source.value)) return

        const importDeclarations = {}
        if (node.source.value === 'lingui-react') {
          node.specifiers.forEach(specifier => {
            importDeclarations[specifier.imported.name] = specifier.local.name
          })

          localTransComponentName = importDeclarations['Trans']
        }

        // Remove imports of i18nMark identity
        node.specifiers = node.specifiers.filter(specifier =>
          specifier.imported.name !== 'i18nMark'
        )

        if (!node.specifiers.length) {
          path.remove()
        }
      },

      // Extract translation from <Trans /> component.
      JSXElement (path, { file }) {
        const { node } = path
        if (!localTransComponentName || !isTransComponent(node)) return

        const attrs = node.openingElement.attributes || []

        const props = attrs.reduce((acc, item) => {
          const key = item.name.name
          if (key === 'id' || key === 'defaults') acc[key] = item.value.value
          return acc
        }, {})

        if (!props.id) {
          console.warn('Missing message ID, skipping.')
          console.warn(generate(node).code)
          return
        }

        collectMessage(path, file, props)
      },

      // Extract translation from i18n._ call
      CallExpression (path, { file }) {
        const { node } = path
        const visited = file.get(VISITED)

        if (
          // we already visited this node
          visited.has(node.callee) ||
          // nothing to extract
          (!isI18nMethod(node.callee) && !isNoopMethod(node.callee))
        ) {
          return
        }

        visited.add(node.callee)

        if (isNoopMethod(node.callee) && !t.isStringLiteral(node.arguments[0])) {
          console.warn('Only string literals are allowed in i18nMark.')
          return
        }

        const attrs = node.arguments[1] && node.arguments[1].properties
          ? node.arguments[1].properties
          : []

        const id = node.arguments[0] && node.arguments[0].value
        if (!id) {
          console.warn('Missing message ID, skipping.')
          console.warn(generate(node).code)
          return
        }

        const props = attrs.reduce((acc, item) => {
          const key = item.key.name
          if (key === 'defaults') acc[key] = item.value.value
          return acc
        }, { id })

        collectMessage(path, file, props)

        if (isNoopMethod(node.callee)) {
          const translation = node.arguments[0]
          path.replaceWith(t.stringLiteral(translation.value))
        }
      }
    },

    pre (file) {
      localTransComponentName = null

      // Ignore else path for now. Collision is possible if other plugin is
      // using the same Symbol('I18nMessages').
      // istanbul ignore else
      if (!file.has(MESSAGES)) {
        file.set(MESSAGES, new Map())
      }

      file.set(VISITED, new WeakSet())
    },

    post (file) {
      /* Write catalog to directory `localeDir`/_build/`path.to.file`/`filename`.json
       * e.g: if file is src/components/App.js (relative to package.json), then
       * catalog will be in locale/_build/src/components/App.json
       */
      const localeDir = this.opts.localeDir || opts.localeDir
      const { filename, basename } = file.opts
      const baseDir = fsPath.dirname(fsPath.relative(optsBaseDir, filename))
      const targetDir = fsPath.join(localeDir, '_build', baseDir)

      const messages = file.get(MESSAGES)
      const catalog = {}

      // no messages, skip file
      if (!messages.size) return

      messages.forEach((value, key) => { catalog[key] = value })

      mkdirp.sync(targetDir)
      fs.writeFileSync(
        fsPath.join(targetDir, `${basename}.json`),
        JSON.stringify(catalog, null, 2)
      )
    }
  }
}
