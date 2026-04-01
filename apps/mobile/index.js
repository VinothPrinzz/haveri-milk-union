import { AppRegistry, View, Text, StyleSheet, ScrollView } from "react-native";
import React from "react";

let RootApp;

try {
  // This will evaluate ALL imports in App.tsx and its children
  const AppModule = require("./App");
  RootApp = AppModule.default || AppModule;
} catch (error) {
  // If App fails to load, show the error on screen
  RootApp = () => (
    React.createElement(View, { style: { flex: 1, backgroundColor: "#1a1a2e", justifyContent: "center", padding: 24 } },
      React.createElement(Text, { style: { fontSize: 20, color: "#e94560", fontWeight: "bold", marginBottom: 12 } }, "App failed to load"),
      React.createElement(ScrollView, null,
        React.createElement(Text, { style: { fontSize: 13, color: "#eee", fontFamily: "monospace" } },
          error ? (error.message || String(error)) : "Unknown error"
        )
      )
    )
  );
  console.error("App load error:", error);
}

AppRegistry.registerComponent("main", () => RootApp);