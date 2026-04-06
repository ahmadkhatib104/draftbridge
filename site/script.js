const pilotRequestForm = document.getElementById("pilot-request-form");

if (pilotRequestForm instanceof HTMLFormElement) {
  pilotRequestForm.addEventListener("submit", (event) => {
    event.preventDefault();

    const formData = new FormData(pilotRequestForm);
    const name = String(formData.get("name") || "").trim();
    const email = String(formData.get("email") || "").trim();
    const store = String(formData.get("store") || "").trim();
    const volume = String(formData.get("volume") || "").trim();
    const notes = String(formData.get("notes") || "").trim();

    const subject =
      "DraftBridge sample PO demo request" + (store ? ` - ${store}` : "");
    const bodyLines = [
      "DraftBridge sample PO demo request",
      "",
      `Name: ${name || "Not provided"}`,
      `Work email: ${email || "Not provided"}`,
      `Shopify store: ${store || "Not provided"}`,
      `Approx. wholesale POs per month: ${volume || "Not provided"}`,
      "",
      "Please attach one sample wholesale PO PDF, CSV, XLSX, or forwarded email.",
      "Redacted customer names or an old fulfilled PO are fine for the demo.",
      "",
      "Notes:",
      notes || "Not provided",
      "",
      "If the sample looks good, please reply with the best install link and next steps.",
    ];

    const mailtoUrl = new URL("mailto:support@draftbridgehq.com");
    mailtoUrl.searchParams.set("subject", subject);
    mailtoUrl.searchParams.set("body", bodyLines.join("\n"));

    window.location.href = mailtoUrl.toString();
  });
}
