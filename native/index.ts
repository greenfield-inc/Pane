// Notify's alert buttons and background task load before the router, so a
// background launch (a button press, a data-only message) runs them too.
import './src/features/notify/notifyBackground';
import 'expo-router/entry';
