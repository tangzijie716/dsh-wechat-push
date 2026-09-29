/**
 * 浏览器半边：助手消息操作条上的「发公众号」入口。
 *
 * 手写成 `window.__ModuleLoader__` 的 factory 格式，而不是从 TSX 构建：官方插件走的是
 * monorepo 的 tsdown client face，外部包够不着；这个格式不需要打包器，React 也直接从宿主取，
 * 于是本包不会带上第二份 React。
 *
 * 所有微信调用都由 Host 负责（见 `lib/remote/service.js`）。本文件只从会话快照里读出被点
 * 的那条消息，并把结果展示出来。
 */
window.__ModuleLoader__.load({
  id: 'dsh-wechat-push',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    /**
     * Remote 契约的线路校验器。
     *
     * 客户端装配只要求每个 codec 有 `parse()`，所以这几个函数顶替 zod，
     * 把 zod 挡在浏览器包之外。Host 那边用真正的 zod schema，由它的 loader 校验。
     */
    function asRecord(value, field) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(field + ': expected object')
      }
      return value
    }
    function asString(value, field) {
      if (typeof value !== 'string') throw new Error(field + ': expected string')
      return value
    }
    function optionalString(value, field) {
      if (value === undefined) return undefined
      return asString(value, field)
    }

    var publishParameterSchema = {
      parse: function (value) {
        var o = asRecord(value, 'PublishRequest')
        var request = {
          markdown: optionalString(o.markdown, 'PublishRequest.markdown'),
          html: optionalString(o.html, 'PublishRequest.html'),
          title: optionalString(o.title, 'PublishRequest.title'),
          theme: optionalString(o.theme, 'PublishRequest.theme'),
          fontSize: optionalString(o.fontSize, 'PublishRequest.fontSize'),
        }
        if (!request.markdown && !request.html) throw new Error('PublishRequest: expected markdown or html')
        return request
      },
    }

    var publishResultSchema = {
      parse: function (value) {
        var o = asRecord(value, 'PublishResult')
        if (typeof o.ok !== 'boolean') throw new Error('PublishResult.ok: expected boolean')
        return {
          ok: o.ok,
          mediaId: optionalString(o.mediaId, 'PublishResult.mediaId'),
          title: optionalString(o.title, 'PublishResult.title'),
          error: optionalString(o.error, 'PublishResult.error'),
          warnings: Array.isArray(o.warnings) ? o.warnings.map(function (item) { return asString(item, 'PublishResult.warnings') }) : undefined,
          deduplicated: o.deduplicated === undefined
            ? undefined
            : (typeof o.deduplicated === 'boolean'
              ? o.deduplicated
              : (function () { throw new Error('PublishResult.deduplicated: expected boolean') })()),
        }
      },
    }

    var TYPERT_REMOTE = {
      package: 'dsh-wechat-push',
      face: 'remote-client',
      schemas: [],
      invocations: [
        {
          id: 'dsh-wechat-push#wechatPush/publish',
          service: 'wechatPush',
          namespace: 'wechatPush',
          method: 'publish',
          invocation: { kind: 'direct' },
          parameters: [
            {
              name: 'request',
              codec: {
                mode: 'strict',
                typeSymbol: 'dsh-wechat-push/remote#PublishRequest',
                schema: publishParameterSchema,
              },
            },
          ],
          result: {
            mode: 'strict',
            typeSymbol: 'dsh-wechat-push/remote#PublishResult',
            schema: publishResultSchema,
          },
          sourceLocation: { file: 'src/remote/service.ts', line: 1, column: 1 },
        },
      ],
    }

    /**
     * 从会话快照里取出被点消息的正文。
     *
     * slot 只交出 `messageId`——这是刻意的，免得贡献者去 import 会话实现。正文只能从快照里
     * 找回来，而快照的节点形状随客户端版本变化，所以这里每一处访问都是防御式的，
     * 不假定某一种布局。
     */
    function messageTextFrom(snapshot, messageId) {
      if (!snapshot) return ''
      var nodes = snapshot.nodes || snapshot.timeline || []
      var parts = []
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i]
        if (!node || node.messageId !== messageId) continue
        var content = node.content || node.blocks || node.parts
        if (typeof content === 'string') { parts.push(content); continue }
        if (!content || typeof content.length !== 'number') continue
        for (var j = 0; j < content.length; j++) {
          var block = content[j]
          if (!block) continue
          if (typeof block === 'string') parts.push(block)
          else if (typeof block.text === 'string') parts.push(block.text)
        }
      }
      return parts.join('')
    }

    /** 操作条上的那一个入口：一个按钮，加它短暂的结果提示。 */
    function PublishAction(props) {
      var state = React.useState({ phase: 'idle', message: '' })
      var status = state[0]
      var setStatus = state[1]
      var snapshot = props.useSession(function (value) { return value })

      var publish = React.useCallback(function () {
        if (status.phase === 'busy') return
        var markdown = messageTextFrom(snapshot, props.messageId)
        if (!markdown.trim()) {
          setStatus({ phase: 'error', message: '这条消息没有可发布的正文' })
          return
        }
        setStatus({ phase: 'busy', message: '' })
        props.remoteRef().then(function (remote) {
          return remote.publish({ markdown: markdown })
        }).then(function (result) {
          if (result && result.ok) {
            var warning = result.warnings && result.warnings.length ? '；' + result.warnings.join('；') : ''
            var duplicate = result.deduplicated ? '（已阻止重复创建）' : ''
            setStatus({ phase: 'done', message: '已存入草稿箱' + duplicate + ':' + (result.title || '') + warning })
          } else {
            setStatus({ phase: 'error', message: (result && result.error) || '发布失败' })
          }
        }).catch(function (error) {
          setStatus({ phase: 'error', message: String((error && error.message) || error) })
        })
      }, [snapshot, props.messageId, status.phase])

      var label = status.phase === 'busy' ? '发布中…' : '发公众号'
      var title = status.phase === 'error' || status.phase === 'done' ? status.message : '把这条回复存入公众号草稿箱'

      var button = React.createElement(
        'button',
        {
          type: 'button',
          onClick: publish,
          disabled: status.phase === 'busy',
          title: title,
          style: {
            background: 'none',
            border: 'none',
            padding: '2px 6px',
            cursor: status.phase === 'busy' ? 'default' : 'pointer',
            font: 'inherit',
            fontSize: '12px',
            opacity: status.phase === 'busy' ? 0.6 : 1,
            color: status.phase === 'error' ? '#b23c3c' : status.phase === 'done' ? '#2f7a55' : 'inherit',
          },
        },
        status.phase === 'done' ? '✓ 已存草稿' : label,
      )
      if (status.phase !== 'error' && status.phase !== 'done') return button
      return React.createElement(
        React.Fragment,
        null,
        button,
        React.createElement('span', {
          role: status.phase === 'error' ? 'alert' : 'status',
          style: { marginLeft: '6px', fontSize: '12px', color: status.phase === 'error' ? '#b23c3c' : '#2f7a55' },
        }, status.message),
      )
    }

    var inject = ['slots', 'remote']

    /**
     * 客户端插件主体：先挂上 Remote 契约，再贡献那个入口。
     * @param ctx - 客户端根 context。
     */
    function apply(ctx) {
      var mountPromise = null
      ctx.effect(function () {
        mountPromise = ctx.remote.$mount(TYPERT_REMOTE)
        return function () {
          if (mountPromise) {
            mountPromise.then(function (dispose) { if (dispose) dispose() }).catch(function () {})
          }
        }
      })

      var remoteRef = function () {
        return mountPromise.then(function () {
          var remote = ctx.get('remote.wechatPush')
          if (!remote) throw new Error('公众号投递服务尚未就绪')
          return remote
        })
      }

      ctx.slots.inject('conversation.chat.assistant-actions', function () {
        return ctx.slots.register(
          {
            name: 'conversation.chat.assistant-actions',
            id: 'wechat-push-publish',
            order: 20,
            label: function () { return '发公众号' },
          },
          function (props) {
            return React.createElement(PublishAction, {
              remoteRef: remoteRef,
              messageId: props.messageId,
              useSession: props.useSession,
            })
          },
        )
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
