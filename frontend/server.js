const express = require('express');
const path = require('path');
const app = express();
const PORT = 3000;

// Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/know-crops', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'know-about-crops.html'));
});

app.get('/library', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'library.html'));
});

app.get('/reset', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reset.html'));
});

app.get('/weather', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'weather.html'));
});

app.get('/calendar', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'calendar.html'));
});


app.get('/crop-selection', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'crop-selection.html'));
});

app.get('/loan-assistant', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'loan-assistant.html'));
});

app.get('/ask-question', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ask-question.html'));
});




// Default route to index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});