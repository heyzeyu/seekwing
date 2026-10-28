import MarkdownIt from 'markdown-it';
export { createTerminal } from './task-terminal.mjs';
export { createTaskView, taskStatuses, isActive } from './task-view.mjs';

// Model output is untrusted. Keep raw HTML disabled, use the parser's escaping,
// and restrict links to explicit web/mail URLs. No remote assets are fetched.
const markdown = new MarkdownIt({ html: false, breaks: true, linkify: false });
const validateLink = markdown.validateLink.bind(markdown);
markdown.validateLink = url => validateLink(url) && /^(https?:|mailto:)/i.test(url);
const linkOpen = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return linkOpen ? linkOpen(tokens, index, options, env, self) : self.renderToken(tokens, index, options);
};
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(`[图片：${tokens[index].content || '图片'}]`);

export function render(text) {
  return markdown.render(text);
}
