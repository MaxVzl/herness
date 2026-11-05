import MarkdownIt from 'markdown-it'

const md = new MarkdownIt({ html: false, linkify: true })
const renderLink = md.renderer.rules.link_open
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  if (token) {
    token.attrSet('target', '_blank')
    token.attrSet('rel', 'noreferrer')
  }
  return renderLink ? renderLink(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options)
}

export function Markdown({ text }: { text: string }) {
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: md.render(text) }} />
}
