import React, { useState, useEffect } from "react";
import { SafeAreaView, StatusBar } from "react-native";
import { lightTheme, darkTheme } from "./colors";
import HomeScreen, { Article } from "./HomeScreen";
import ArticleScreen from "./ArticleScreen";
import { registerForPushNotifications } from "./pushNotifications";

export default function App() {
  const [isDark, setIsDark] = useState(false);
  const [selectedArticle, setSelectedArticle] = useState<Article | null>(null);
  const theme = isDark ? darkTheme : lightTheme;

  useEffect(() => {
    registerForPushNotifications();
  }, []);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.background }}>
      <StatusBar barStyle={isDark ? "light-content" : "dark-content"} backgroundColor={theme.headerBg} />
      {selectedArticle ? (
        <ArticleScreen theme={theme} article={selectedArticle} onBack={() => setSelectedArticle(null)} />
      ) : (
        <HomeScreen
          theme={theme}
          onToggleTheme={() => setIsDark((v) => !v)}
          onOpenArticle={(article) => setSelectedArticle(article)}
        />
      )}
    </SafeAreaView>
  );
}
