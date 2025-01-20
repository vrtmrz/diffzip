import { Modal, type App, Setting, type Plugin, type ButtonComponent, MarkdownRenderer } from "obsidian";

export class InputStringDialog extends Modal {
	result: string | false = false;
	onSubmit: (result: string | false) => void;
	title: string;
	key: string;
	placeholder: string;
	isManuallyClosed = false;
	isPassword = false;

	constructor(
		app: App,
		title: string,
		key: string,
		placeholder: string,
		isPassword: boolean,
		onSubmit: (result: string | false) => void
	) {
		super(app);
		this.onSubmit = onSubmit;
		this.title = title;
		this.placeholder = placeholder;
		this.key = key;
		this.isPassword = isPassword;
	}

	onOpen() {
		const { contentEl } = this;
		this.titleEl.setText(this.title);
		const formEl = contentEl.createDiv();
		new Setting(formEl)
			.setName(this.key)
			.setClass(this.isPassword ? "password-input" : "normal-input")
			.addText((text) =>
				text.onChange((value) => {
					this.result = value;
				})
			);
		new Setting(formEl)
			.addButton((btn) =>
				btn
					.setButtonText("Ok")
					.setCta()
					.onClick(() => {
						this.isManuallyClosed = true;
						this.close();
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText("Cancel")
					.setCta()
					.onClick(() => {
						this.close();
					})
			);
	}

	onClose() {
		super.onClose();
		const { contentEl } = this;
		contentEl.empty();
		if (this.isManuallyClosed) {
			this.onSubmit(this.result);
		} else {
			this.onSubmit(false);
		}
	}
}

export class MessageBox extends Modal {
	plugin: Plugin;
	title: string;
	contentMd: string;
	buttons: string[];
	result: string | false = false;
	isManuallyClosed = false;
	defaultAction: string | undefined;

	defaultButtonComponent: ButtonComponent | undefined;
	wideButton: boolean;

	onSubmit: (result: string | false) => void;

	constructor(
		plugin: Plugin,
		title: string,
		contentMd: string,
		buttons: string[],
		defaultAction: (typeof buttons)[number],
		wideButton: boolean,
		onSubmit: (result: (typeof buttons)[number] | false) => void
	) {
		super(plugin.app);
		this.plugin = plugin;
		this.title = title;
		this.contentMd = contentMd;
		this.buttons = buttons;
		this.onSubmit = onSubmit;
		this.defaultAction = defaultAction;
		this.wideButton = wideButton;

	}

	onOpen() {
		const { contentEl } = this;
		this.titleEl.setText(this.title);
		const div = contentEl.createDiv();
		div.style.userSelect = "text";
		void MarkdownRenderer.render(this.plugin.app, this.contentMd, div, "/", this.plugin);
		const buttonSetting = new Setting(contentEl);


		buttonSetting.infoEl.style.display = "none";
		buttonSetting.controlEl.style.flexWrap = "wrap";
		if (this.wideButton) {
			buttonSetting.controlEl.style.flexDirection = "column";
			buttonSetting.controlEl.style.alignItems = "center";
			buttonSetting.controlEl.style.justifyContent = "center";
			buttonSetting.controlEl.style.flexGrow = "1";
		}

		for (const button of this.buttons) {
			buttonSetting.addButton((btn) => {
				btn.setButtonText(button).onClick(() => {
					this.isManuallyClosed = true;
					this.result = button;
					this.close();
				});
				if (button == this.defaultAction) {
					this.defaultButtonComponent = btn;
					btn.setCta();
				}
				if (this.wideButton) {
					btn.buttonEl.style.flexGrow = "1";
					btn.buttonEl.style.width = "100%";
				}
				return btn;
			});
		}
	}

	onClose() {
		super.onClose();
		const { contentEl } = this;
		contentEl.empty();
		if (this.isManuallyClosed) {
			this.onSubmit(this.result);
		} else {
			this.onSubmit(false);
		}
	}
}

export function confirmWithMessage(
	plugin: Plugin,
	title: string,
	contentMd: string,
	buttons: string[],
	defaultAction: (typeof buttons)[number],
): Promise<(typeof buttons)[number] | false> {
	return new Promise((res) => {
		const dialog = new MessageBox(plugin, title, contentMd, buttons, defaultAction, false, (result) =>
			res(result)
		);
		dialog.open();
	});
}
