/**
 * User app Vue main entry point
 */

import { createApp } from 'vue';
import { Quasar } from 'quasar';
import App from './App.vue';

// Quasar components and styles
import '@quasar/extras/material-icons/material-icons.css';
import 'quasar/src/css/index.sass';

const app = createApp(App);

app.use(Quasar, {
  plugins: {
    Dialog: true,
    Notify: true
  }
});

app.mount('#app');

