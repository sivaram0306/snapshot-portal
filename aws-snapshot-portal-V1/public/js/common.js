/* =====================================================
   STORAGE
===================================================== */

function getRegion() {

  return localStorage.getItem("awsRegion")
    || "ap-south-1";

}


function setRegion(region) {

  localStorage.setItem(
    "awsRegion",
    region
  );

}


function getAccount() {

  return localStorage.getItem("awsAccount")
    || "production";

}


function setAccount(account) {

  localStorage.setItem(
    "awsAccount",
    account
  );

}


/* =====================================================
   COMMON CONTROLS
===================================================== */

document.addEventListener(
  "DOMContentLoaded",
  () => {

    const region =
      document.getElementById("regionSelect");

    const account =
      document.getElementById("accountSelect");


    if (region) {

      region.value =
        getRegion();

      region.addEventListener(
        "change",
        () => {

          setRegion(
            region.value
          );

        }
      );

    }


    if (account) {

      account.value =
        getAccount();

      account.addEventListener(
        "change",
        () => {

          setAccount(
            account.value
          );

        }
      );

    }


    checkConnection();

  }
);


/* =====================================================
   STATUS
===================================================== */

async function checkConnection() {

  try {

    const response =
      await fetch("/api/status");

    const result =
      await response.json();

    updateConnection(
      result.connected
    );

  } catch {

    updateConnection(false);

  }

}


function updateConnection(connected) {

  document
    .querySelectorAll(".connection")
    .forEach(element => {

      element.classList.toggle(
        "connected",
        connected
      );

      const text =
        element.querySelector(
          ".connection-text"
        );

      if (text) {

        text.textContent =
          connected
            ? "Connected"
            : "Disconnected";

      }

    });

}


/* =====================================================
   TOAST
===================================================== */

function toast(message) {

  let element =
    document.getElementById("toast");


  if (!element) {

    element =
      document.createElement("div");

    element.id = "toast";

    element.className =
      "toast";

    document.body.appendChild(
      element
    );

  }


  element.textContent =
    message;

  element.classList.add("show");


  clearTimeout(
    window.toastTimeout
  );


  window.toastTimeout =
    setTimeout(() => {

      element.classList.remove(
        "show"
      );

    }, 3000);

}


/* =====================================================
   HTML ESCAPE
===================================================== */

function escapeHtml(value) {

  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

}


/* =====================================================
   STATUS HTML
===================================================== */

function statusHtml(state) {

  const value =
    String(state || "")
      .toLowerCase();

  return `
    <span class="status status-${value}">
      <span class="status-dot"></span>
      ${escapeHtml(state)}
    </span>
  `;

}


/* =====================================================
   DATE
===================================================== */

function formatDate(value) {

  if (!value) {
    return "-";
  }

  return new Date(value)
    .toLocaleString();

}


/* =====================================================
   DISCONNECT
===================================================== */

async function disconnectAWS() {

  try {

    await fetch(
      "/api/disconnect",
      {
        method: "POST"
      }
    );

    updateConnection(false);

    toast(
      "AWS disconnected."
    );

  } catch (error) {

    toast(
      error.message
    );

  }

}
