const note = document.getElementById('note');
const STORAGE_KEY = 'pad.note';

function loadSavedNote() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved !== null) {
    note.value = saved;
  }
}

function persistNote(value) {
  localStorage.setItem(STORAGE_KEY, value);
}

loadSavedNote();

note.addEventListener('input', event => {
  persistNote(event.target.value);
});
