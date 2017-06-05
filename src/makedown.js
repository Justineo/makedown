(function () {
  const API_ENDPOINT = 'https://www.zhihu.com/api/v4'

  // global states
  let editor
  let answerId
  let userData = {}
  let md = new Remarkable({
    html: true,
    langPrefix: ''
  })
  md.inline.ruler.push('inline-tex', inlineTeX)

  if (!isAnswer() && !isArticle()) {
    return
  }

  if (isAnswer()) {
    if (!window.wrappedJSObject) { // not Firefox
      window.addEventListener('message', ({ source, data }) => {
        if (source != window) {
          return
        }

        if (data.type && (data.type == 'makedown-data')) {
          let { content, id } = data.payload
          content = convertToMarkdown(content)
          editor.value = content
          answerId = id || null
          syncHeight(editor)
          focusEnd(editor)
        }
      }, false)

      /**
       * Get state from React by pretending to be React Developer Tools
       */
      let script = document.createElement('script')
      script.textContent = `
        (function () {
          function findReactComponent (elem) {
            for (let key in elem) {
              if (key.startsWith('__reactInternalInstance$')) {
                return elem[key]._currentElement._owner._instance
              }
            }
            return null
          }

          window.addEventListener('message', ({ source, data }) => {
            if (data.type === 'makedown-query') {
              let node = document.querySelector('[data-makedown-answer]').parentNode.parentNode
              let instance = findReactComponent(node)
              if (!instance) {
                return
              }
              let { answer } = instance.props
              content = answer.editableContent
              id = answer.id

              window.postMessage({
                type: 'makedown-data',
                payload: { content, id }
              }, '*')
            }
          })
        })()`
      document.documentElement.appendChild(script)
      script.parentNode.removeChild(script)
    }
  }

  $(function () {
    if (document.querySelector('.AnswerForm-editor')) {
      makedownAnswer()
      return
    }

    let observer = new MutationObserver(mutations => {
      mutations.forEach(({ type, target, addedNodes }) => {
        if (type === 'childList') {
          if (addedNodes.length && [...addedNodes].find(isAnswerEditor)) {
            makedownAnswer()
          } else if (target.matches('.entry-content')) {
            makedownArticle()
          }
        }
      })
    })

    let observeConfig = {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true
    }

    observer.observe(document.body, observeConfig)
  })

  function makedownAnswer () {
    if (document.getElementById('makedown')) {
      return
    }

    /**
     * Initialize the editor overlay
     */
    let richEditor = document.querySelector('.AnswerForm-editor')
    let submitButton = document.querySelector('.AnswerForm-submit')
    if (!richEditor || !submitButton) {
      return
    }

    document.body.classList.add('makedown-enabled')
    document.body.classList.add('makedown-answer')

    editor = createEditor(richEditor, {
      placeholder: '写回答...'
    })

    /**
     * Hijacking DOM events
     */
    submitButton.addEventListener('click', submitAnswer, true)

    let $editor = $(editor)
    if (!$editor.parents('.QuestionAnswers-answerAdd').length) {
      ($editor.closest('.List-item')[0] || $editor.closest('.Card')[0]).scrollIntoView()
      document.body.scrollTop -= 62
    }

    /**
     * Get editable content from page script
     */
    queryAnswer()
  }

  function makedownArticle () {
    if (document.getElementById('makedown')) {
      return
    }

    /**
     * Initialize the editor overlay
     */
    let richEditor = document.querySelector('.editable-container')
    let submitButton = document.querySelector('.navbar-publish-container .pop-button')
    if (!richEditor || !submitButton) {
      return
    }

    document.body.classList.add('makedown-enabled')
    document.body.classList.add('makedown-article')

    let placeholder = '请输入正文'
    editor = createEditor(richEditor, {
      placeholder
    })

    editor.addEventListener('focus', () => { editor.placeholder = '' })
    editor.addEventListener('blur', () => { editor.placeholder = placeholder })

    /**
     * Hijacking DOM events
     */
    submitButton.addEventListener('click', syncArticle, true)

    /**
     * Get editable content from DOM
     */
    let content = richEditor.querySelector('.entry-content')
    if (content.querySelector('.holdertext')) {
      editor.value = ''
    } else {
      editor.value = convertToMarkdown(content.innerHTML)
    }
    syncHeight(editor)
  }

  function createEditor (container, options = {}) {
    let main = createElement('div', {
      id: 'makedown'
    })
    container.appendChild(main)

    let editor = createElement('textarea', Object.assign({
      id: 'makedown-editor',
      spellcheck: false
    }, options))
    main.appendChild(editor)

    editor.addEventListener('input', () => {
      syncHeight(editor)
    })

    $(editor).atwho({
      at: '@',
      limit: 6,
      callbacks: {
        beforeInsert (value, $li) {
          let name = $li.children('span').text().trim()
          return `[@${name}](https://www.zhihu.com/people/${userData[name].hash})`
        },
        tplEval (tpl, { name, id, avatar, desc }) {
          return `<li title="${desc}"><img src="${avatar}"><span>${name}</span><small>${id}</small></li>`
        },
        remoteFilter (query, callback) {
          if (!query) {
            callback([])
            return
          }
          let url = `https://www.zhihu.com/people/autocomplete?token=${encodeURIComponent(query)}&max_matches=10&use_similar=0`
          fetch(url)
            .then(json)
            .then(([result]) => {
              let users = []
              result.slice(1).forEach(entry => {
                let user = {
                  name: entry[1],
                  id: entry[2],
                  avatar: entry[3].replace(/_s.jpg$/, '_m.jpg'),
                  hash: entry[4],
                  desc: entry[5]
                }
                userData[user.name] = user
                users.push(user)
              })
              callback(users)
            })
        }
      }
    })

    editor.addEventListener('paste', ({ clipboardData }) => {
      let { files, items } = clipboardData
      let fileItems = [...items].filter(({ type }) => type === 'file')
      if (!files.length && !fileItems.length) {
        return
      }
      upload(files[0] || fileItems[0].getAsFile(), url => {
        let text = `![](${url})`
        $(editor).selection('replace', {
          text,
          caret: 'keep'
        })
      })
    })

    return editor
  }

  function upload (file, callback) {
    if (!file) {
      return
    }
    let field
    let url
    if (isArticle()) {
      field = 'upload_file'
      url = 'https://zhuanlan.zhihu.com/api/upload'
    } else {
      field = 'picture'
      url = 'https://www.zhihu.com/api/v4/uploaded_images'
    }
    let data = new FormData()
    data.append(field, file)
    let token = (document.cookie.match(/XSRF-TOKEN=([\da-zA-Z|]+)/) || [])[1]
    let headers = {}
    if (token) {
      headers['X-XSRF-TOKEN'] = token
    }
    editor.disabled = true

    fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: data
      })
      .then(json)
      .then((result) => {
        editor.disabled = false
        if (typeof callback === 'function') {
          if (isArticle()) {
            callback(result.msg[0])
          } else {
            callback(result.src)
          }
        }
      })
  }

  function syncHeight (elem) {
    editor.style.height = `${editor.scrollHeight}px`
  }

  function submitAnswer (e) {
    if (!editor) {
      return
    }

    let answerId = getAnswerId()
    let questionId = getQuestionId()
    let content = convertToHTML(editor.value)

    if (answerId) {
      saveAnswer(answerId, content)
    } else if (questionId) {
      createAnswer(questionId, content)
    }

    e.preventDefault()
    e.stopPropagation()
  }

  function queryAnswer () {
    if (window.wrappedJSObject) {
      let doc = window.wrappedJSObject.document
      let node = doc.querySelector('.AnswerForm-editor').parentNode.parentNode
      let instance = findReactComponent(node)
      if (!instance) {
        return
      }
      let { answer } = instance.props
      content = convertToMarkdown(answer.editableContent)
      answerId = answer.id
      editor.value = content
      answerId = id || null
      syncHeight(editor)
      focusEnd(editor)
    } else {
      $('.AnswerForm-editor').attr('data-makedown-answer', '')
      window.postMessage({
        type: 'makedown-query'
      }, '*')
    }
  }

  function focusEnd (editor) {
    setTimeout(() => {
      editor.focus()
      let { length } = editor.value
      editor.setSelectionRange(length, length)
    }, 0)
  }

  function json (response) {
    return response.json()
  }

  function createAnswer (questionId, content) {
    let url = `${API_ENDPOINT}/questions/${questionId}/answers`
    fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({
          content,
          reshipment_settings: getReshipmentSettings ()
        })
      })
      .then(json)
      .then(({ id }) => {
        if (id) {
          location.assign(`${location.origin}${location.pathname}/answer/${id}`)
        }
      })
  }

  function saveAnswer (answerId, content) {
    let url = `${API_ENDPOINT}/answers/${answerId}`
    fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({ content })
      })
      .then(json)
      .then(() => {
        location.assign(`${location.origin}${location.pathname}`)
      })
  }

  function syncArticle () {
    let richText = document.querySelector('.entry-content')
    richText.innerHTML = convertToHTML(editor.value)
    // to trigger autosave to make the update valid
    richText.focus()
    richText.blur()
  }

  function convertToMarkdown (html) {
    return prepareGeneratedMarkdown(toMarkdown(prepareLoadedHTML(html), {
      converters: [
        {
          filter: 'li',
          replacement (content, node) {
            content = content.trim().replace(/\n/gm, '\n  ')
            let parent = node.parentNode
            let index = [...parent.children].indexOf(node) + 1

            let prefix = parent.nodeName.toLowerCase() === 'ol' ? `{index}. ` : '* '
            return prefix + content
          }
        },
        {
          filter: 'pre',
          replacement (content, node) {
            return '\n\n```' + (node.lang === 'text' ? '' : node.lang) + '\n' + node.textContent.trim() + '\n```\n\n'
          }
        },
        {
          filter (node) {
            return node.matches('img[eeimg="1"]')
          },
          replacement (content, node) {
            return ` $${node.alt}$ `
          }
        }
      ]
    }))
  }

  function convertToHTML (markdown) {
    return prepareGeneratedHTML(md.render(markdown))
  }

  function prepareGeneratedMarkdown (markdown) {
    return markdown
      .replace(/(^|\n)(\s*)([*-]|\d+\.)\s+/g, '$1$2$3 ')
      .split('\n')
      .map(line => line.replace(/\s+$/, ''))
      .join('\n')
      .trim()
  }

  function prepareLoadedHTML (html) {
    let wrapper = createElement('div', {
      id: 'makedown-wrapper',
      innerHTML: html
    })

    // remove Zhihu redirect for links
    Array.from(wrapper.getElementsByTagName('a')).forEach(a => {
      a.href = decodeURIComponent(a.href.replace(/https?:\/\/link\.zhihu\.com\/\?target=/, ''))
    })

    return wrapper.innerHTML
  }

  function prepareGeneratedHTML (html) {
    let wrapper = createElement('div', {
      id: 'makedown-wrapper',
      innerHTML: html
    })

    // convert all code block to format Zhihu can handle
    Array.from(wrapper.querySelectorAll('pre > code')).forEach(code => {
      if (code.className) {
        code.parentNode.setAttribute('lang', code.className)
        code.parentNode.innerHTML = code.innerHTML
      }
    })

    // remove all non-top-level <p> tags
    Array.from(wrapper.getElementsByTagName('p')).forEach(p => {
      if (p.parentNode.id !== 'makedown-wrapper') {
        p.insertAdjacentHTML('afterend', p.innerHTML)
        p.parentNode.removeChild(p)
      }
    })

    // trimming all text nodes for non-<pre> tags
    Array.from(wrapper.querySelectorAll('#makedown-wrapper > :not(pre)')).forEach(elem => {
      getTextNodes(elem).forEach(node => {
        node.nodeValue = node.nodeValue.trim()
      })
    })

    // convert @ mentions
    Array.from(wrapper.querySelectorAll('a')).forEach(a => {
      let href = a.href
      let [match, hash] = href.match(/https:\/\/www\.zhihu\.com\/people\/([\da-zA-Z]+)/) || []
      if (!match) {
        return
      }
      a.className = 'member_mention'
      a.dataset.hash = hash
      a.href = `/people/${hash}`
      a.parentNode.insertBefore(document.createTextNode(' '), a)
      a.parentNode.insertBefore(document.createTextNode(' '), a.nextSibling)
    })

    // convert LaTex expression imgs
    Array.from(wrapper.querySelectorAll('img[src^="https://www.zhihu.com/equation?tex="]')).forEach(img => {
      img.setAttribute('eeimg', '1')
    })

    return wrapper.innerHTML
      .replace(/>\n+</g, '><') // remove unwanted line breaks
      .trim()
  }

  function createElement (tagName, props) {
    let elem = document.createElement(tagName)
    return Object.assign(elem, props)
  }

  function getTextNodes (node) {
    let textNodes = []
    Array.from(node.childNodes).forEach(child => {
      if (child.nodeType === Node.TEXT_NODE) {
        textNodes.push(child)
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        textNodes = textNodes.concat(getTextNodes(child))
      }
    })
    return textNodes
  }

  const reshipmentMap = {
    '允许付费转载': 'need_payment',
    '允许规范转载': 'allowed',
    '禁止转载': 'disallowed'
  }
  function getReshipmentSettings () {
    let text = document.querySelector('.AnswerForm-footerRight .Popover button').textContent.trim()
    return reshipmentMap[text]
  }

  function getQuestionId () {
    return (location.host === 'www.zhihu.com' && location.pathname.match(/^\/question\/(\d+)/) || [])[1]
  }

  function getAnswerId () {
    return (location.host === 'www.zhihu.com' && location.pathname.match(/^\/question\/\d+\/answer\/(\d+)/) || [])[1] || answerId
  }

  function isAnswer () {
    return getQuestionId() || getAnswerId()
  }

  function isArticle () {
    return location.host === 'zhuanlan.zhihu.com' && location.pathname.match(/^\/(?:p\/\d+\/edit|write$)/)
  }

  function isAnswerEditor (node) {
    return node.nodeType === Node.ELEMENT_NODE && node.matches('.AnswerForm-editor')
  }

  function findReactComponent (elem) {
    for (let key in elem) {
      if (key.startsWith('__reactInternalInstance$')) {
        return elem[key]._currentElement._owner._instance
      }
    }
    return null
  }

  function inlineTeX (state, silent) {
    let pos = state.pos
    let ch = state.src.charCodeAt(pos)

    if (ch !== 36) {
      return false
    }

    let start = pos
    pos++
    let max = state.posMax

    while (pos < max && state.src.charCodeAt(pos) === 36) {
      pos++
    }

    let marker = state.src.slice(start, pos)

    let matchStart = matchEnd = pos

    while ((matchStart = state.src.indexOf('$', matchEnd)) !== -1) {
      matchEnd = matchStart + 1

      while (matchEnd < max && state.src.charCodeAt(matchEnd) === 36) {
        matchEnd++
      }

      if (matchEnd - matchStart === marker.length) {
        if (!silent) {
          let tex = state.src.slice(pos, matchStart).replace(/[ \n]+/g, ' ').trim()
          state.push({
            type: 'image',
            src: `https://www.zhihu.com/equation?tex=${encodeURIComponent(tex)}`,
            alt: tex,
            block: false,
            level: state.level
          })
        }
        state.pos = matchEnd
        return true
      }
    }

    if (!silent) {
      state.pending += marker
    }
    state.pos += marker.length
    return true
  }
})()
