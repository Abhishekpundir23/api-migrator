export default {
  "inngest": {
    "before": {
      "sourceFiles": 301,
      "wouldChangeFiles": 7,
      "findings": [
        {
          "code": "T1",
          "kind": "applied",
          "count": 7
        },
        {
          "code": "F4",
          "kind": "review",
          "count": 1
        },
        {
          "code": "F12",
          "kind": "review",
          "count": 1
        }
      ],
      "note": "The scanner proposed trigger changes in all seven function files that the maintainer migrated.",
      "highlights": [
        [
          "T1",
          "Move legacy trigger arguments into function options."
        ],
        [
          "F4",
          "Review the event schema against the v4 types."
        ]
      ]
    },
    "after": {
      "sourceFiles": 301,
      "wouldChangeFiles": 0,
      "findings": [
        {
          "code": "F12",
          "kind": "review",
          "count": 1
        }
      ],
      "note": "The trigger edits and schema warning cleared in the merged checkout.",
      "highlights": [
        [
          "F12",
          "Verify checkpointing settings and timeouts for the deployment."
        ]
      ]
    }
  },
  "knock": {
    "before": {
      "sourceFiles": 294,
      "wouldChangeFiles": 6,
      "findings": [
        {
          "code": "K2",
          "kind": "applied",
          "count": 1
        },
        {
          "code": "K3",
          "kind": "applied",
          "count": 1
        },
        {
          "code": "K4",
          "kind": "applied",
          "count": 10
        },
        {
          "code": "K5",
          "kind": "applied",
          "count": 4
        },
        {
          "code": "KF1",
          "kind": "review",
          "count": 1
        },
        {
          "code": "KF6",
          "kind": "review",
          "count": 2
        }
      ],
      "note": "Across the full repository, 16 proposed edits and three manual reviews cover all seven files involved in the Knock migration.",
      "highlights": [
        [
          "K2",
          "Rename users.identify to users.update."
        ],
        [
          "K5",
          "Move the API key and legacy host into v1 client options."
        ],
        [
          "KF6",
          "Narrow provider-specific channel data before reading connections."
        ]
      ]
    },
    "after": {
      "sourceFiles": 294,
      "wouldChangeFiles": 0,
      "findings": [],
      "note": "The scanner found zero proposed edits and zero manual findings in the merged repository.",
      "highlights": []
    }
  }
};
