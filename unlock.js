const ACCESS_CODE = "xuanpin2026";
const ACCESS_STORAGE_KEY = "offsiteSelectionAccessCode";

const passwordInput = document.querySelector("#passwordInput");
const unlockButton = document.querySelector("#unlockButton");
const unlockError = document.querySelector("#unlockError");

function enterDashboard() {
  const code = passwordInput.value.trim();
  unlockError.textContent = "";

  if (code !== ACCESS_CODE) {
    unlockError.textContent = "访问码不正确，请重新输入。";
    return;
  }

  sessionStorage.setItem(ACCESS_STORAGE_KEY, code);
  window.location.href = "./dashboard.html";
}

unlockButton.addEventListener("click", enterDashboard);
passwordInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    enterDashboard();
  }
});
passwordInput.focus();
