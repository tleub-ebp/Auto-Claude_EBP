import { describe, expect, it } from "vitest";
import {
	classifyTestStrategy,
	isGeneratableStrategy,
} from "../test-strategy";

describe("classifyTestStrategy", () => {
	it("skips test files, designers and non-source assets", () => {
		expect(classifyTestStrategy("src/__tests__/foo.test.ts")).toBe("skip");
		expect(classifyTestStrategy("src/components/Foo.spec.tsx")).toBe("skip");
		expect(classifyTestStrategy("Forms/ThirdEntryForm.Designer.cs")).toBe("skip");
		expect(classifyTestStrategy("Tests/ThirdEntryFormTests.cs")).toBe("skip");
		expect(classifyTestStrategy("package.json")).toBe("skip");
		expect(classifyTestStrategy("README.md")).toBe("skip");
		expect(classifyTestStrategy("styles/app.css")).toBe("skip");
		expect(classifyTestStrategy("Properties/Resources.resx")).toBe("skip");
	});

	it("classifies API controllers and routes", () => {
		expect(classifyTestStrategy("Controllers/InvoiceController.cs")).toBe("api");
		expect(classifyTestStrategy("src/routes/users.ts")).toBe("api");
		expect(classifyTestStrategy("src/users/users.controller.ts")).toBe("api");
		expect(classifyTestStrategy("api/orders.py")).toBe("api");
	});

	it("classifies WinForms/WPF surfaces as desktop UI", () => {
		expect(
			classifyTestStrategy("Forms/ThirdEntryFormBase.cs", [
				"Forms/ThirdEntryFormBase.cs",
			]),
		).toBe("desktop-ui");
		expect(classifyTestStrategy("Views/MainWindow.xaml.cs")).toBe("desktop-ui");
		// Designer sibling marks the file as a designed surface even without
		// a Form-like name
		expect(
			classifyTestStrategy("Surfaces/InvoiceGrid.cs", [
				"Surfaces/InvoiceGrid.cs",
				"Surfaces/InvoiceGrid.Designer.cs",
			]),
		).toBe("desktop-ui");
	});

	it("classifies web UI files as web E2E", () => {
		expect(classifyTestStrategy("src/components/Invoice.tsx")).toBe("e2e-web");
		expect(classifyTestStrategy("src/pages/Home.vue")).toBe("e2e-web");
		expect(classifyTestStrategy("Views/Invoice/Index.cshtml")).toBe("e2e-web");
	});

	it("defaults source files to unit tests", () => {
		expect(classifyTestStrategy("Services/InvoiceService.cs")).toBe("unit");
		expect(classifyTestStrategy("src/lib/compute.ts")).toBe("unit");
		expect(classifyTestStrategy("core/billing.py")).toBe("unit");
	});

	it("handles Windows separators", () => {
		expect(classifyTestStrategy("Controllers\\InvoiceController.cs")).toBe("api");
		expect(
			classifyTestStrategy("Surfaces\\Grid.cs", [
				"Surfaces\\Grid.Designer.cs",
				"Surfaces\\Grid.cs",
			]),
		).toBe("desktop-ui");
	});

	it("exposes generatable strategies", () => {
		expect(isGeneratableStrategy("unit")).toBe(true);
		expect(isGeneratableStrategy("skip")).toBe(false);
	});
});
