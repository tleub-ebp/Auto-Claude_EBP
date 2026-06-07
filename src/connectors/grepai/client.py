import requests


class GrepaiClient:
    def __init__(self, base_url="http://localhost:9000"):
        self.base_url = base_url

    def health(self):
        try:
            response = requests.get(f"{self.base_url}/health", timeout=(5, 10))
            response.raise_for_status()
            return response.json()
        except Exception as e:
            return {"error": str(e)}

    def search(self, query, top_k=5):
        """
        Effectue une recherche via l'API Grepai.
        :param query: Texte à rechercher
        :param top_k: Nombre de résultats souhaités
        :return: Résultat JSON de l'API Grepai
        """
        try:
            payload = {"query": query, "top_k": top_k}
            response = requests.post(
                f"{self.base_url}/search", json=payload, timeout=(5, 30)
            )
            response.raise_for_status()
            return response.json()
        except Exception as e:
            return {"error": str(e)}

    # Ajoutez ici d'autres méthodes selon l'API grepai
