import type { ToolHandler } from '../types.js';
import { addPendingInteractive } from '../media.js';

const handler: ToolHandler = {
  name: 'send_buttons',
  definition: {
    name: 'send_buttons',
    description: 'Send WhatsApp interactive message with buttons or a list. Use for quick replies, time selection, or service choices.',
    input_schema: {
      type: 'object' as const,
      properties: {
        body: { type: 'string', description: 'Message body text (required)' },
        buttons: {
          type: 'array',
          description: 'Quick reply buttons (max 3). Each: {id, title (max 20 chars)}',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
            },
            required: ['id', 'title'],
          },
        },
        list_sections: {
          type: 'array',
          description: 'List menu sections. Each: {title, rows: [{id, title, description?}]}. Use instead of buttons when >3 options.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              rows: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    title: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['id', 'title'],
                },
              },
            },
            required: ['title', 'rows'],
          },
        },
        list_button_text: { type: 'string', description: 'Button text for list (default: "בחר אופציה")' },
        header: { type: 'string', description: 'Optional header text' },
        footer: { type: 'string', description: 'Optional footer text' },
        cta_url: {
          type: 'object',
          description: 'CTA URL button (opens link). {display_text, url}',
          properties: {
            display_text: { type: 'string' },
            url: { type: 'string' },
          },
        },
      },
      required: ['body'],
    },
  },
  async execute(input) {
    if (!input.buttons && !input.list_sections && !input.cta_url) {
      return 'Error: Must provide buttons, list_sections, or cta_url.';
    }

    addPendingInteractive({
      interactiveBody: input.body,
      interactiveHeader: input.header,
      interactiveFooter: input.footer,
      buttons: input.buttons,
      listSections: input.list_sections,
      listButtonText: input.list_button_text,
      ctaUrl: input.cta_url,
    });

    if (input.buttons) {
      return `Interactive buttons message queued: ${input.buttons.map((b: any) => b.title).join(', ')}`;
    }
    if (input.list_sections) {
      const totalRows = input.list_sections.reduce((n: number, s: any) => n + s.rows.length, 0);
      return `Interactive list message queued: ${totalRows} options`;
    }
    if (input.cta_url) {
      return `CTA button queued: "${input.cta_url.display_text}" → ${input.cta_url.url}`;
    }
    return 'Interactive message queued.';
  },
};

export default handler;
