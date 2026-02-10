/**
 * User app Vue main entry point
 */

import { createApp } from 'vue';
import { Quasar, Dialog, Notify } from 'quasar';
import App from './App.vue';

// Quasar components and styles
import '@quasar/extras/material-icons/material-icons.css';
import 'quasar/src/css/index.sass';

const app = createApp(App);

app.use(Quasar, {
  plugins: {
    Dialog,
    Notify
  }
});

// Defer mount until page is fully loaded to avoid "Layout was forced before the page was fully loaded"
// and reduce flash of unstyled content (FOUC), especially in Firefox
function mountApp() {
  app.mount('#app');
}
if (document.readyState === 'complete') {
  mountApp();
} else {
  window.addEventListener('load', mountApp);
}

