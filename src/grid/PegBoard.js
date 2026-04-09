import { createTextBlock } from '../elements/TextBlock.js';
import { createImageBlock } from '../elements/ImageBlock.js';
import { createSplitBlock } from '../elements/SplitBlock.js';

const elementFactories = {
  text: createTextBlock,
  image: createImageBlock,
  split: createSplitBlock,
};

export class PegBoard {
  constructor(container, options = {}) {
    this.container = container;
    this.columns = options.columns || 12;
    this.rowHeight = options.rowHeight || 100;
    this.gap = options.gap || 16;
    this.elements = new Map();

    this.setup();
  }

  setup() {
    this.container.classList.add('pegboard');
    this.container.style.setProperty('--pg-columns', this.columns);
    this.container.style.setProperty('--pg-row-height', `${this.rowHeight}px`);
    this.container.style.setProperty('--pg-gap', `${this.gap}px`);
  }

  addElement(config) {
    const wrapper = document.createElement('div');
    wrapper.classList.add('peg-element');
    wrapper.dataset.id = config.id;
    wrapper.dataset.type = config.type;

    wrapper.style.gridColumn = `${config.gridColumn} / span ${config.colSpan || 1}`;
    wrapper.style.gridRow = `${config.gridRow} / span ${config.rowSpan || 1}`;

    const factory = elementFactories[config.type];
    if (!factory) {
      console.warn(`Unknown element type: ${config.type}`);
      return;
    }

    const element = factory(config.content);
    wrapper.appendChild(element);
    this.container.appendChild(wrapper);
    this.elements.set(config.id, { config, wrapper, element });
  }

  removeElement(id) {
    const entry = this.elements.get(id);
    if (entry) {
      entry.wrapper.remove();
      this.elements.delete(id);
    }
  }

  loadLayout(layout) {
    if (layout.grid) {
      this.columns = layout.grid.columns || this.columns;
      this.rowHeight = layout.grid.rowHeight || this.rowHeight;
      this.gap = layout.grid.gap || this.gap;
      this.setup();
    }
    layout.elements.forEach((el) => this.addElement(el));
  }

  getLayoutData() {
    const elements = [];
    this.elements.forEach(({ config }) => elements.push(config));
    return {
      grid: {
        columns: this.columns,
        rowHeight: this.rowHeight,
        gap: this.gap,
      },
      elements,
    };
  }
}
