#!/usr/bin/env python3
"""
Démarre un ou plusieurs serveurs, attend qu'ils soient prêts, exécute une commande, puis nettoie.

Usage:
    # Serveur unique
    python scripts/with_server.py --server "npm run dev" --port 5173 -- python automation.py
    python scripts/with_server.py --server "npm start" --port 3000 -- python test.py

    # Serveurs multiples
    python scripts/with_server.py \
      --server "cd backend && python server.py" --port 3000 \
      --server "cd frontend && npm run dev" --port 5173 \
      -- python test.py
"""

import argparse
import shlex
import socket
import subprocess
import sys
import time


def is_server_ready(port, timeout=30):
    """Attend que le serveur soit prêt en interrogeant le port."""
    start_time = time.time()
    while time.time() - start_time < timeout:
        try:
            with socket.create_connection(('localhost', port), timeout=1):
                return True
        except (OSError, ConnectionRefusedError):
            time.sleep(0.5)
    return False


def main():
    parser = argparse.ArgumentParser(description='Exécuter une commande avec un ou plusieurs serveurs')
    parser.add_argument('--server', action='append', dest='servers', required=True, help='Commande du serveur (peut être répétée)')
    parser.add_argument('--port', action='append', dest='ports', type=int, required=True, help='Port pour chaque serveur (doit correspondre au nombre de --server)')
    parser.add_argument('--timeout', type=int, default=30, help='Timeout en secondes par serveur (défaut: 30)')
    parser.add_argument('--shell', action='store_true', help="Interpréter --server via le shell (nécessaire pour 'cd && cmd'). Sans ce flag, la commande est tokenisée par shlex.")
    parser.add_argument('command', nargs=argparse.REMAINDER, help='Commande à exécuter après que les serveurs soient prêts')

    args = parser.parse_args()

    # Supprimer le séparateur '--' s'il est présent
    if args.command and args.command[0] == '--':
        args.command = args.command[1:]

    if not args.command:
        print("Erreur: Aucune commande spécifiée à exécuter")
        sys.exit(1)

    # Parser les configurations de serveur
    if len(args.servers) != len(args.ports):
        print("Erreur: Le nombre d'arguments --server et --port doit correspondre")
        sys.exit(1)

    servers = []
    for cmd, port in zip(args.servers, args.ports):
        servers.append({'cmd': cmd, 'port': port})

    server_processes = []

    try:
        # Démarrer tous les serveurs
        for i, server in enumerate(servers):
            print(f"Démarrage du serveur {i+1}/{len(servers)}: {server['cmd']}")

            # Par défaut on tokenise via shlex (sûr). Le flag --shell active
            # shell=True pour les chaînages style 'cd backend && cmd' — à
            # n'utiliser qu'avec des commandes contrôlées par le développeur.
            if args.shell:
                process = subprocess.Popen(
                    server['cmd'],
                    shell=True,  # noqa: S602 — opt-in via --shell
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE
                )
            else:
                process = subprocess.Popen(
                    shlex.split(server['cmd']),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE
                )
            server_processes.append(process)

            # Attendre que ce serveur soit prêt
            print(f"En attente du serveur sur le port {server['port']}...")
            if not is_server_ready(server['port'], timeout=args.timeout):
                raise RuntimeError(f"Le serveur a échoué à démarrer sur le port {server['port']} dans les {args.timeout}s")

            print(f"Serveur prêt sur le port {server['port']}")

        print(f"\nTous les {len(servers)} serveur(s) prêt(s)")

        # Exécuter la commande
        print(f"Exécution: {' '.join(args.command)}\n")
        result = subprocess.run(args.command)
        sys.exit(result.returncode)

    finally:
        # Nettoyer tous les serveurs
        print(f"\nArrêt de {len(server_processes)} serveur(s)...")
        for i, process in enumerate(server_processes):
            try:
                process.terminate()
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            print(f"Serveur {i+1} arrêté")
        print("Tous les serveurs arrêtés")


if __name__ == '__main__':
    main()
