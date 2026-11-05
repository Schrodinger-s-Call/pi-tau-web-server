import { renderMarkdown } from './markdown.js';

self.onmessage = (event: MessageEvent<string>) => {
  self.postMessage(renderMarkdown(event.data));
};
