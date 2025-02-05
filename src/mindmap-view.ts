import {
  EventRef,
  ItemView,
  Menu,
  TFile,
  Vault,
  Workspace,
  WorkspaceLeaf,
  debounce,
  MarkdownView,
  Editor,
} from "obsidian";
import { Transformer, builtInPlugins } from "markmap-lib";
import { Markmap, loadCSS, loadJS, deriveOptions } from "markmap-view";
import { INode, IMarkmapOptions, IMarkmapJSONOptions } from "markmap-common";
import { Toolbar } from "markmap-toolbar";
import { ZoomTransform } from "d3-zoom";

import { MD_VIEW_TYPE, MM_VIEW_TYPE } from "./constants";
import ObsidianMarkmap from "./obsidian-markmap-plugin";
import { createSVG, getComputedCss, removeExistingSVG } from "./markmap-svg";
import { takeScreenshot } from "./copy-image";
import { htmlEscapePlugin, checkBoxPlugin } from "./plugins";

export default class MindmapView extends ItemView {
  file: TFile;
  linkedLeaf: WorkspaceLeaf;
  displayText: string;
  workspace: Workspace;
  listeners: EventRef[];
  emptyDiv: HTMLDivElement;
  svg: SVGElement;
  obsMarkmap: ObsidianMarkmap;
  settings: MindMapSettings;
  currentTransform: ZoomTransform;
  markmapSVG: Markmap;
  transformer: Transformer;
  options: Partial<IMarkmapOptions>;
  frontmatterOptions: FrontmatterOptions;
  hasFit: boolean;
  toolbar: HTMLElement;
  pinned: boolean = false;

  getViewType(): string {
    return MM_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.displayText ?? "Mind Map";
  }

  getIcon() {
    return "dot-network";
  }

  onMoreOptionsMenu(menu: Menu) {
    menu
      .addItem((item) =>
        item
          .setIcon("pin")
          .setTitle(this.pinned ? "Unpin" : "Pin")
          .onClick(() => this.pinned ? this.unPin() : this.pinCurrentLeaf())
      )
      .addItem((item) =>
        item
          .setIcon("image-file")
          .setTitle("Copy screenshot")
          .onClick(() =>
            takeScreenshot(
              this.settings,
              this.markmapSVG,
              this.frontmatterOptions
            )
          )
      )
      .addItem((item) =>
        item
          .setIcon("folder")
          .setTitle("Collapse All")
          .onClick(() => this.collapseAll())
      )
      .addItem((item) =>
        item
          .setIcon("view")
          .setTitle("Toogle toolbar")
          .onClick(() => this.toggleToolbar())
      );

    menu.showAtPosition({ x: 0, y: 0 });
  }

  constructor(settings: MindMapSettings, leaf: WorkspaceLeaf) {
    super(leaf);
    this.settings = settings;
    this.workspace = this.app.workspace;

    this.transformer = new Transformer([
      ...builtInPlugins,
      htmlEscapePlugin,
      checkBoxPlugin,
    ]);
    this.svg = createSVG(this.containerEl, this.settings.lineHeight);

    this.hasFit = false;

    this.createMarkmapSvg();

    this.createToolbar();

    this.setListenersUp();

    this.leaf.on('pinned-change', (pinned) => this.pinned = pinned)
  }

  createMarkmapSvg() {
    const { font } = getComputedCss(this.containerEl);

    this.options = {
      autoFit: false,
      color: this.applyColor.bind(this),
      duration: 500,
      style: (id) => `${id} * {font: ${font}}`,
      nodeMinHeight: this.settings.nodeMinHeight ?? 16,
      spacingVertical: this.settings.spacingVertical ?? 5,
      spacingHorizontal: this.settings.spacingHorizontal ?? 80,
      paddingX: this.settings.paddingX ?? 8,
      embedGlobalCSS: true,
      fitRatio: 1,
    };

    this.markmapSVG = Markmap.create(this.svg, this.options);
  }

  toggleToolbar() {
    if (this.toolbar) {
      this.toolbar.remove();
      this.toolbar = undefined;
    } else {
      this.createToolbar();
    }
  }

  createToolbar() {
    const container = document.createElement("div");
    container.className = "markmap-toolbar-container";

    const el = Toolbar.create(this.markmapSVG) as HTMLElement;

    container.append(el);
    this.containerEl.append(container);

    this.toolbar = container;
  }

  setListenersUp() {
    const editorChange: (
      editor: Editor,
      markdownView: MarkdownView
    ) => any = (editor) => {
      const content = editor.getValue();
      const pinned = this.leaf.getViewState().pinned
      if (! pinned) this.update(content);
    };

    const debouncedEditorChange = debounce(editorChange, 300, true);

    this.listeners = [
      this.workspace.on("editor-change", debouncedEditorChange),
      this.workspace.on("file-open", (file) => {
        this.file = file;
        const pinned = this.leaf.getViewState().pinned
        if (! pinned) this.update();
      }),
      this.leaf.on("pinned-change", (pinned) => {
        if (! pinned) this.update();
      }),
    ];
  }

  async onOpen() {
    this.obsMarkmap = new ObsidianMarkmap(this.app.vault);

    this.file = this.app.workspace.getActiveFile();

    this.workspace.onLayoutReady(async () => await this.update());
  }

  async onClose() {
    this.listeners.forEach((listener) => this.workspace.offref(listener));
  }

  async updateLinkedLeaf(group: string, mmView: MindmapView) {
    if (group === null) {
      mmView.linkedLeaf = undefined;
      return;
    }
    const mdLinkedLeaf = mmView.workspace
      .getGroupLeaves(group)
      .filter((l) => l?.view?.getViewType() === MM_VIEW_TYPE)[0];
    mmView.linkedLeaf = mdLinkedLeaf;

    await this.update();
  }

  pinCurrentLeaf() {
    this.leaf.setPinned(true);
  }

  unPin() {
    this.leaf.setPinned(false);
  }

  collapseAll() {
    this.markmapSVG.setData(this.markmapSVG.state.data, {
      ...this.options,
      initialExpandLevel: 0,
    });
  }

  async update(content?: string) {
    this.applyCodeBlockBgColor() 
    try {
      const markdown =
        typeof content === "string" ? content : await this.readMarkDown();

      if (!markdown) return;

      let { root, scripts, styles, frontmatter } = await this.transformMarkdown(
        markdown
      );

      const actualFrontmatter = frontmatter as CustomFrontmatter;

      const markmapOptions = deriveOptions(frontmatter?.markmap);
      this.frontmatterOptions = {
        ...markmapOptions,
        screenshotTextColor: actualFrontmatter?.markmap?.screenshotTextColor,
        screenshotBgColor: actualFrontmatter?.markmap?.screenshotBgColor,
      };

      if (styles) loadCSS(styles);
      if (scripts) loadJS(scripts);

      this.renderMarkmap(root, markmapOptions, frontmatter?.markmap ?? {});

      this.displayText =
        this.file.name != undefined
          ? `Mind Map of ${this.file.name}`
          : "Mind Map";

      setTimeout(() => this.applyWidths(), 100);
    } catch (error) {
      console.log("Error on update: ", error);
    }
  }

  async readMarkDown() {
    try {
      return await this.app.vault.cachedRead(this.file);
    } catch (error) {
      console.log(error);
    }
  }

  sanitiseMarkdown(markdown: string) {
    // Remove info string from code fence unless it is "js" or "javascript"
    // transformer.transform can't handle other languages
    const allowedLanguages = ["js", "javascript", "css", "html"]
    return markdown.replace(/```(.+)/, (_, capture) => {
      const backticks = capture.match(/(`*).*/)?.[1]
      const infoString = capture.match(/`*(.*)/)?.[1]
      const t = infoString?.trim()
      const sanitisedInfoString = allowedLanguages.includes(t) ? t : ""
      return "```" + (backticks || "") + sanitisedInfoString
    })
  }

  async transformMarkdown(markdown: string) {
    const sanitisedMarkdown = this.sanitiseMarkdown(markdown)
    let { root, features, frontmatter } = this.transformer.transform(sanitisedMarkdown);

    const { scripts, styles } = this.transformer.getUsedAssets(features);

    this.obsMarkmap.updateInternalLinks(root);
    return { root, scripts, styles, frontmatter };
  }

  applyColor(frontmatterColors: string[]) {
    return ({ depth }: INode) => {
      if (this.settings.coloring == "single") return this.settings.defaultColor;

      const colors = frontmatterColors?.length
        ? frontmatterColors
        : [this.settings.color1, this.settings.color2, this.settings.color3];

      if (frontmatterColors?.length) return colors[depth % colors.length];
      else
        return depth < colors.length
          ? colors[depth]
          : this.settings.defaultColor;
    };
  }

  applyCodeBlockBgColor() {
    let style = this.svg.firstChild as SVGStyleElement;
    let sheet: CSSStyleSheet = style?.sheet;
    sheet.insertRule(`.markmap-foreign pre[class*=language-] { background-color: ${this.settings.codeBlockBgColor} }`, sheet.cssRules.length - 1);
    sheet.insertRule(`.markmap-foreign code { background-color: ${this.settings.codeBlockBgColor} }`, sheet.cssRules.length - 1);
  }

  applyWidths() {
    if (!this.svg) return;

    const colors = [
      this.settings.color1Thickness,
      this.settings.color2Thickness,
      this.settings.color3Thickness,
      this.settings.defaultColorThickness,
    ];

    this.svg
      .querySelectorAll("path.markmap-link")
      .forEach((el: SVGPathElement) => {
        const colorIndex = Math.min(3, parseInt(el.dataset.depth));

        el.style.strokeWidth = `${colors[colorIndex]}`;
      });

    this.svg.querySelectorAll("g.markmap-node").forEach((el: SVGGElement) => {
      const line = el.querySelector("line");

      const colorIndex = Math.min(3, parseInt(el.dataset.depth));
      line.style.strokeWidth = `${colors[colorIndex]}`;
    });

    this.svg.querySelectorAll("circle").forEach((el) => {
      this.registerDomEvent(el as unknown as HTMLElement, "click", () =>
        setTimeout(() => this.applyWidths(), 50)
      );
    });
  }

  async renderMarkmap(
    root: INode,
    { color, ...frontmatterOptions }: Partial<IMarkmapOptions>,
    frontmatter: Partial<IMarkmapJSONOptions> = {}
  ) {
    try {
      const { font, color: computedColor } = getComputedCss(this.containerEl);

      const colorFn =
        this.settings.coloring === "depth"
          ? this.applyColor(frontmatter?.color)
          : color;

      this.options = {
        autoFit: false,
        style: (id) => `${id} * {font: ${font}}`,
        nodeMinHeight: this.settings.nodeMinHeight ?? 16,
        spacingVertical: this.settings.spacingVertical ?? 5,
        spacingHorizontal: this.settings.spacingHorizontal ?? 80,
        paddingX: this.settings.paddingX ?? 8,
        embedGlobalCSS: true,
        fitRatio: 1,
        initialExpandLevel: this.settings.initialExpandLevel ?? -1,
        maxWidth: this.settings.maxWidth ?? 0,
        duration: this.settings.animationDuration ?? 500,
      };

      if (colorFn) {
        this.options.color = colorFn;
      }

      if (computedColor) {
        this.svg.setAttr(
          "style",
          `--mm-line-height: ${this.settings.lineHeight ?? "1em"};`
        );
      }

      this.markmapSVG.setData(root, {
        ...this.options,
        ...frontmatterOptions,
      });

      if (!this.hasFit) {
        this.markmapSVG.fit();
        this.hasFit = true;
      }
    } catch (error) {
      console.error(error);
    }
  }
}
